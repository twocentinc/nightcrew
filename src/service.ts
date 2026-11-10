import type { OperationalLog } from "./logging.js";
import { checkpoint, withoutExecution } from "./execution.js";
import {
  builtinTools,
  loadRegistry,
  validateRegistry,
  toolDefinitionSchema,
  executeExternalTool,
  type ToolDefinition,
} from "./registry.js";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  agentSchema,
  skillSchema,
  toolID,
  validateAttachments,
  validateConfig,
  now,
  terminal,
  type Agent,
  type Run,
  type Message,
  type UserMessage,
  type Skill,
  type ChatInput,
  type Config,
  type Event,
} from "./contracts.js";
import { Storage, canonical, summarize } from "./storage.js";

export function fail(code: string, status = 400): never {
  throw new ORPCError(code, { status, message: code });
}
export const tools = builtinTools;
export type Result = {
  text: string;
  toolCalls: Message["toolCalls"];
  usage: { inputTokens: number; outputTokens: number };
};
export interface Runtime {
  initialize?(): Promise<void>;
  isBusy?(): boolean;
  snapshot?(
    slotID: string,
    action: "save" | "restore",
    dryRun: boolean,
  ): Promise<{
    slotID: string;
    action: string;
    changed: boolean;
    directory: string;
  }>;
  generate(
    input: {
      modelID: string;
      slotID: string;
      messages: Message[];
      tools: ChatInput["tools"];
      thinking?: boolean;
      maxOutputTokens: number;
      temperature: number;
    },
    signal: AbortSignal,
    onDelta?: (text: string) => void,
  ): Promise<Result>;
  // Must settle only after owned computation has stopped, including on abort.
  close(): Promise<void>;
  status(): { modelID: string; state: string }[];
}
export type Presence = {
  state: "present" | "away";
  reason: string;
  samplingHealthy: boolean;
  observedAt: string;
  diagnostic: string | null;
};
type Chat = {
  requestID: string;
  input: ChatInput;
  state: string;
  createdAt: string;
  updatedAt: string;
  result: Result | null;
  error: { code: string; message: string } | null;
  events: Event[];
  expires: number;
  deadline: number;
};
type Page = { key: string; items: unknown[]; offset: number; expires: number };
export class Service {
  readonly skills = new Map<string, Skill>();
  readonly tools = new Map<string, ToolDefinition>();
  async reloadRegistry() {
    const registry = await loadRegistry(this.storage.home);
    validateRegistry(
      this.storage.store.agents,
      registry.skills,
      registry.tools,
    );
    this.skills.clear();
    for (const [id, s] of registry.skills) this.skills.set(id, s);
    this.tools.clear();
    for (const [id, t] of registry.tools) this.tools.set(id, t);
  }
  readonly chats = new Map<string, Chat>();
  readonly provisional = new Map<string, { attemptID: string; text: string }>();
  private deltas(id: string) {
    const value = { attemptID: randomUUID(), text: "" };
    this.provisional.set(id, value);
    return (text: string) => {
      if (Buffer.byteLength(value.text) + Buffer.byteLength(text) > 1048576)
        throw Error("Output limit");
      value.text += text;
    };
  }
  private pages = new Map<string, Page>();
  private hookWork = new Set<Promise<void>>();
  private liveRuns = new Map<string, Run>();
  private scheduleHooks(run: Run) {
    const task = withoutExecution(() => this.deliverHooks(run)).catch(() => {});
    this.hookWork.add(task);
    void task.finally(() => this.hookWork.delete(task));
  }
  private timer?: ReturnType<typeof setInterval>;
  private pumping = false;
  private closed = false;
  private active?: {
    id: string;
    kind: "run" | "chat";
    controller: AbortController;
  };
  private settling: Promise<void> = Promise.resolve();
  presence: Presence = {
    state: "present",
    reason: "samplingFailure",
    samplingHealthy: false,
    observedAt: now(),
    diagnostic: "Presence not yet sampled",
  };
  constructor(
    readonly storage: Storage,
    readonly runtime: Runtime,
    readonly samplePresence: () => Promise<Presence>,
    private logger?: OperationalLog,
  ) {}
  async initialize() {
    await this.storage.initialize();
    try {
      await this.runtime.initialize?.();
      await this.reloadRegistry();
      await this.storage.exclusive(async () => {
        const next = structuredClone(this.storage.store);
        next.cooldownUntil = new Date(
          Math.max(
            Date.parse(next.cooldownUntil ?? "") || 0,
            Date.now() + next.config.interactionCooldownMs,
          ),
        ).toISOString();
        await this.storage.saveConfig(next);
        for (const summary of this.storage.summaries.values()) {
          const r = await this.storage.read(summary.runID);
          let changed = false;
          for (const receipt of r.hookReceipts)
            if (receipt.status === "started" || receipt.status === "pending") {
              receipt.status = "unknown";
              receipt.diagnostic =
                "Daemon stopped during delivery; not retried";
              changed = true;
            }
          if (!terminal(r.state)) {
            r.state = "paused";
            r.pauseReason = "restart";
            this.event(r, "interrupted", {});
            changed = true;
          }
          if (changed) await this.save(r);
        }
      });
      for (const a of this.storage.store.agents) this.validateAgent(a);
      await this.tick();
      this.timer = setInterval(() => {
        void this.tick().catch(() => {
          this.presence = {
            state: "present",
            reason: "samplingFailure",
            samplingHealthy: false,
            observedAt: now(),
            diagnostic: "Presence sampling failed",
          };
        });
      }, 1000);
      this.timer.unref();
    } catch (e) {
      await this.storage.close();
      throw e;
    }
  }
  private event(r: Run, type: Event["type"], data: Event["data"]) {
    r.events.push({
      sequence: r.events.length + 1,
      at: now(),
      type,
      segment: r.segment,
      data,
    });
  }
  private async save(r: Run) {
    r.revision++;
    r.updatedAt = now();
    await this.storage.write(r);
  }
  publicConfig(config = this.storage.store.config) {
    const { rootTokenHash, models, hooks, ...rest } = config;
    return {
      ...rest,
      models: models.map(({ modelID, kind, idleUnloadMs }) => ({
        modelID,
        kind,
        idleUnloadMs,
      })),
      hooks: hooks.map(({ event, timeoutMs }) => ({ event, timeoutMs })),
    };
  }
  status() {
    return {
      presence: this.presence,
      cooldownUntil: this.storage.store.cooldownUntil,
      activeRunID: this.active?.kind === "run" ? this.active.id : null,
      queue: [
        ...Array.from(this.storage.summaries.values())
          .filter((x) => !terminal(x.state))
          .map((x) => ({
            resourceID: x.runID,
            kind: "run",
            state: x.state,
            blockingReason: x.pauseReason,
          })),
        ...Array.from(this.chats.values())
          .filter((x) => !terminal(x.state))
          .map((x) => ({
            resourceID: x.requestID,
            kind: "chat",
            state: x.state,
            blockingReason: null,
          })),
      ],
      models: this.runtime.status(),
      slots: this.storage.store.config.slots.map((s) => ({
        ...s,
        busy: !!this.active && this.activeSlot() === s.slotID,
        conversationID:
          this.active?.kind === "chat"
            ? (this.chats.get(this.active.id)?.input.conversationID ?? null)
            : null,
      })),
    };
  }
  private activeSlot() {
    return this.active?.kind === "chat"
      ? this.chats.get(this.active.id)?.input.slotID
      : this.activeRunSlot;
  }
  private activeRunSlot?: string;
  agent(agentID: string) {
    return (
      this.storage.store.agents.find((a) => a.agentID === agentID) ??
      fail("agent_not_found", 404)
    );
  }
  async run(runID: string) {
    if (!this.storage.summaries.has(runID)) fail("run_not_found", 404);
    return this.storage.read(runID);
  }
  detail(r: Run) {
    return {
      ...summarize(r),
      agent: r.agent,
      skills: r.skills,
      result: r.result,
      error: r.error,
      hookReceipts: r.hookReceipts.map(({ executablePath, ...x }) => x),
    };
  }
  validateAgent(a: Agent) {
    validateRegistry([a], this.skills, this.tools);
    for (const s of a.skillIDs) {
      const skill = this.skills.get(s) ?? fail("skill_not_found", 400);
      if (skill.toolIDs.some((t) => !a.toolIDs.includes(t)))
        fail("skill_tool_not_allowed");
    }
  }
  async createAgent(
    draft: Omit<Agent, "revision" | "createdAt" | "updatedAt">,
    dryRun = false,
  ) {
    return this.storage.exclusive(async () => {
      if (this.storage.store.agents.some((a) => a.agentID === draft.agentID))
        fail("agent_exists", 409);
      const agent = agentSchema.parse({
        ...draft,
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      });
      this.validateAgent(agent);
      const next = structuredClone(this.storage.store);
      next.agents.push(agent);
      this.valid(next);
      if (!dryRun) await this.storage.saveConfig(next);
      return { agent, changed: !dryRun };
    });
  }
  private valid(store: typeof this.storage.store) {
    try {
      validateConfig(store);
    } catch {
      fail("invalid_configuration");
    }
  }
  async patchAgent(
    agentID: string,
    expectedRevision: number,
    changes: Partial<Agent>,
    dryRun = false,
  ) {
    return this.storage.exclusive(async () => {
      const prev = this.agent(agentID);
      if (prev.revision !== expectedRevision) fail("revision_conflict", 409);
      const agent = agentSchema.parse({
        ...prev,
        ...changes,
        revision: prev.revision + 1,
        updatedAt: now(),
      });
      this.validateAgent(agent);
      const next = structuredClone(this.storage.store);
      next.agents = next.agents.map((a) => (a.agentID === agentID ? agent : a));
      this.valid(next);
      if (!dryRun) await this.storage.saveConfig(next);
      return { agent, changed: !dryRun };
    });
  }
  async patchConfig(
    expectedRevision: number,
    changes: {
      logging?: Config["logging"];
      interactionCooldownMs?: number;
      slots?: Config["slots"];
      modelIdlePolicies?: { modelID: string; idleUnloadMs: number }[];
    },
    dryRun = false,
  ) {
    return this.storage.exclusive(async () => {
      const next = structuredClone(this.storage.store);
      if (next.config.revision !== expectedRevision)
        fail("revision_conflict", 409);
      if (changes.slots && this.status().queue.length)
        fail("runtime_busy", 409);
      if (changes.logging !== undefined) next.config.logging = changes.logging;
      if (changes.interactionCooldownMs !== undefined)
        next.config.interactionCooldownMs = changes.interactionCooldownMs;
      if (changes.slots) next.config.slots = changes.slots;
      for (const p of changes.modelIdlePolicies ?? []) {
        const model =
          next.config.models.find((m) => m.modelID === p.modelID) ??
          fail("unknown_model");
        model.idleUnloadMs = p.idleUnloadMs;
      }
      next.config.revision++;
      this.valid(next);
      if (!dryRun) {
        if (changes.slots) await this.runtime.close();
        await this.storage.saveConfig(next);
      }
      return {
        config: this.publicConfig(next.config),
        changed: !dryRun,
        restartRequired: !!changes.slots,
      };
    });
  }
  page<T>(
    key: string,
    input: { limit: number; cursor?: string },
    items: () => Promise<T[]> | T[],
  ) {
    return this.paginate(key, input, items);
  }
  private async paginate<T>(
    key: string,
    { limit, cursor }: { limit: number; cursor?: string },
    get: () => Promise<T[]> | T[],
  ) {
    for (const [id, p] of this.pages)
      if (p.expires < Date.now()) this.pages.delete(id);
    let p: Page;
    if (cursor) {
      p = this.pages.get(cursor) ?? fail("cursor_expired", 410);
      if (p.key !== key + "|" + limit) fail("cursor_query_mismatch");
    } else {
      p = {
        key: key + "|" + limit,
        items: structuredClone(await get()),
        offset: 0,
        expires: Date.now() + 300000,
      };
    }
    const result = p.items.slice(p.offset, p.offset + limit) as T[];
    const offset = p.offset + limit;
    let nextCursor: string | null = null;
    if (offset < p.items.length) {
      if (
        this.pages.size >= 100 ||
        Buffer.byteLength(JSON.stringify([...this.pages.values(), p])) >
          128 * 1024 * 1024
      )
        fail("cursor_capacity", 429);
      nextCursor = randomUUID();
      this.pages.set(nextCursor, { ...p, offset });
    }
    return { items: result, nextCursor };
  }
  async listRuns(agentID?: string, state?: string) {
    await this.storage.reconcile();
    return [...this.storage.summaries.values()]
      .filter(
        (r) =>
          (!agentID || r.agentID === agentID) && (!state || r.state === state),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.runID.localeCompare(b.runID),
      );
  }
  transcript(r: Run) {
    return r.events.map((e) => ({
      ...e,
      message:
        e.data &&
        typeof e.data === "object" &&
        !Array.isArray(e.data) &&
        "messageID" in e.data
          ? (r.messages.find(
              (m) =>
                m.messageID === (e.data as { messageID: string }).messageID,
            ) ?? null)
          : null,
    }));
  }
  async search(query: string, agentID?: string, state?: string) {
    const matches = [];
    for (const s of await this.listRuns(agentID, state)) {
      checkpoint();
      const r = await this.run(s.runID);
      const seen = new Set<string>();
      for (const e of this.transcript(r)) {
        if (e.message && seen.has(e.message.messageID)) continue;
        if (e.message) seen.add(e.message.messageID);
        const text =
          (e.message?.content ?? "") +
          (e.message?.attachments
            .filter((a) => a.mediaType !== "audio/wav")
            .map(
              (a) =>
                "\n" + Buffer.from(a.dataBase64, "base64").toString("utf8"),
            )
            .join("") ?? "");
        const offset = text.toLowerCase().indexOf(query.toLowerCase());
        if (offset >= 0) {
          const start = Math.max(0, offset - 200);
          matches.push({
            runID: r.runID,
            eventSequence: e.sequence,
            segment: e.segment,
            excerpt: text.slice(start, start + 1000),
            matchOffset: offset - start,
          });
        }
      }
      if (r.result && !r.messages.some((m) => m.content === r.result)) {
        const offset = r.result.toLowerCase().indexOf(query.toLowerCase());
        const event = [...r.events]
          .reverse()
          .find((e) => e.type === "completed");
        if (offset >= 0 && event) {
          const start = Math.max(0, offset - 200);
          matches.push({
            runID: r.runID,
            eventSequence: event.sequence,
            segment: event.segment,
            excerpt: r.result.slice(start, start + 1000),
            matchOffset: offset - start,
          });
        }
      }
    }
    return matches;
  }
  private capacity() {
    if (this.status().queue.length >= 100) fail("queue_capacity", 429);
    if (this.storage.unreadable.length) fail("run_index_unavailable", 503);
  }
  private checkMessage(message: UserMessage, modelID: string) {
    const model =
      this.storage.store.config.models.find((m) => m.modelID === modelID) ??
      fail("unknown_model");
    try {
      validateAttachments([{ ...message, role: "user" }], model.kind);
    } catch {
      fail("invalid_attachments");
    }
  }
  private acceptance(r: Run, replayed: boolean) {
    return {
      runID: r.runID,
      status: r.state,
      eventsURL: `/v1/runs/${r.runID}/events`,
      replayed,
    };
  }
  async submit(
    target: string,
    message: UserMessage,
    reply = false,
    dryRun = false,
  ) {
    if (reply && this.active?.id === target) await this.settling;
    const out = await this.storage.exclusive(async () => {
      await this.storage.reconcile();
      if (this.storage.unreadable.length) fail("run_index_unavailable", 503);
      const existing = this.storage.messages.get(message.messageID);
      if (existing) {
        const r = await this.run(existing.runID);
        const m = r.messages[existing.index]!;
        if (
          (reply
            ? r.runID !== target || existing.index === 1
            : r.agent.agentID !== target || existing.index !== 1) ||
          canonical({
            messageID: m.messageID,
            content: m.content,
            attachments: m.attachments,
            ...(m.thinking === undefined ? {} : { thinking: m.thinking }),
          }) !== canonical(message)
        )
          fail("message_conflict", 409);
        return this.acceptance(r, true);
      }
      if (
        [...this.chats.values()].some(
          (c) => c.input.messages.at(-1)?.messageID === message.messageID,
        )
      )
        fail("message_conflict", 409);
      this.capacity();
      const previous = reply ? await this.run(target) : null;
      const a = previous?.agent ?? this.agent(target);
      this.checkMessage(message, a.modelID);
      if (reply && !message.content.trim() && !message.attachments.length)
        fail("empty_reply");
      if (previous && previous.state !== "completed")
        fail("run_not_completed", 409);
      const r: Run = previous ?? {
        version: 2,
        toolSnapshots: a.toolIDs.map((id) =>
          JSON.parse(JSON.stringify(this.tools.get(id))),
        ),
        runID: randomUUID(),
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
        agent: structuredClone(a),
        skills: a.skillIDs.map((s) =>
          structuredClone(this.skills.get(s) ?? fail("skill_not_found")),
        ),
        segment: 0,
        state: "queued",
        pauseReason: null,
        activeMs: 0,
        messages: [
          {
            messageID: randomUUID(),
            role: "system",
            content: a.systemPrompt,
            attachments: [],
            toolCalls: [],
            toolCallID: null,
          },
        ],
        events: [],
        result: null,
        error: null,
        hookReceipts: [],
      };
      if (previous) {
        r.segment++;
        r.activeMs = 0;
        r.result = null;
        r.error = null;
        r.revision++;
      }
      r.state = "queued";
      r.pauseReason = null;
      r.updatedAt = now();
      r.messages.push({
        ...message,
        role: "user",
        toolCalls: [],
        toolCallID: null,
      });
      this.event(r, "message", { messageID: message.messageID });
      this.event(r, "queued", {});
      if (Buffer.byteLength(JSON.stringify(r)) > 56 * 1024 * 1024)
        fail("run_capacity", 507);
      if (!dryRun) {
        await this.storage.write(r, !previous);
        if (this.instantSlot(a.slotID)) {
          await this.recordInteraction();
          if (
            this.active?.kind === "run" &&
            !this.instantSlot(this.activeSlot())
          )
            this.active.controller.abort("instant");
        }
      }
      return this.acceptance(r, false);
    });
    if (!dryRun) this.wake();
    return out;
  }
  async cancelRun(runID: string, dryRun = false) {
    const r = await this.run(runID);
    if (terminal(r.state) || dryRun)
      return { runID, status: r.state, changed: false };
    if (this.active?.id === runID) {
      this.active.controller.abort("cancelled");
      await this.settling;
      return { runID, status: (await this.run(runID)).state, changed: true };
    }
    const outcome = await this.storage.exclusive(async () => {
      const current = await this.run(runID);
      if (terminal(current.state))
        return { runID, status: current.state, changed: false };
      current.state = "cancelled";
      current.pauseReason = null;
      this.event(current, "cancelled", {});
      await this.save(current);
      return { runID, status: current.state, changed: true };
    });
    if (outcome.changed) this.scheduleHooks(await this.run(runID));
    return outcome;
  }
  chat(requestID: string) {
    this.expire();
    return this.chats.get(requestID) ?? fail("request_unavailable", 404);
  }
  chatDetail(c: Chat) {
    return {
      requestID: c.requestID,
      conversationID: c.input.conversationID,
      modelID: c.input.modelID,
      state: c.state,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      result: c.result,
      error: c.error,
    };
  }
  private chatEvent(c: Chat, type: Event["type"], data: Event["data"]) {
    c.updatedAt = now();
    c.events.push({
      sequence: c.events.length + 1,
      at: now(),
      type,
      segment: 0,
      data,
    });
  }
  private expire() {
    for (const [id, c] of this.chats)
      if (terminal(c.state) && c.expires < Date.now()) this.chats.delete(id);
  }
  async submitChat(input: ChatInput) {
    const out = await this.storage.exclusive(async () => {
      await this.storage.reconcile();
      this.expire();
      const latest = input.messages.at(-1)!;
      if (!["user", "tool"].includes(latest.role))
        fail("invalid_submission_role");
      if (
        new Set(input.messages.map((m) => m.messageID)).size !==
          input.messages.length ||
        new Set(input.tools.map((t) => t.name)).size !== input.tools.length
      )
        fail("duplicate_identity");
      const pending = new Set<string>();
      for (const m of input.messages) {
        if (m.role === "tool") {
          if (!m.toolCallID || !pending.delete(m.toolCallID))
            fail("invalid_tool_pairing");
        } else {
          if (pending.size) fail("missing_tool_result");
          if (m.toolCallID !== null) fail("invalid_tool_pairing");
        }
        if (m.toolCalls.length && m.role !== "assistant")
          fail("invalid_tool_pairing");
        for (const t of m.toolCalls) {
          if (pending.has(t.callID)) fail("duplicate_tool_call");
          pending.add(t.callID);
        }
      }
      if (pending.size) fail("missing_tool_result");
      if (this.storage.messages.has(latest.messageID))
        fail("message_conflict", 409);
      const old = [...this.chats.values()].find(
        (c) => c.input.messages.at(-1)?.messageID === latest.messageID,
      );
      if (old) {
        if (canonical(old.input) !== canonical(input))
          fail("message_conflict", 409);
        return {
          requestID: old.requestID,
          status: old.state,
          eventsURL: `/v1/chat/requests/${old.requestID}/events`,
          replayed: true,
        };
      }
      const slot =
        this.storage.store.config.slots.find(
          (s) => s.slotID === input.slotID && s.modelID === input.modelID,
        ) ?? fail("invalid_slot");
      if (
        this.storage.store.config.models.find(
          (m) => m.modelID === input.modelID,
        )?.kind !== "chat"
      )
        fail("unsupported_model");
      try {
        validateAttachments(input.messages, "chat");
      } catch {
        fail("invalid_attachments");
      }
      if (
        [...this.chats.values()].some(
          (c) =>
            c.input.conversationID === input.conversationID &&
            !terminal(c.state),
        )
      )
        fail("conversation_busy", 409);
      this.capacity();
      if (
        this.chats.size >= 8 ||
        Buffer.byteLength(JSON.stringify(input)) > 6 * 1024 * 1024
      )
        fail("request_capacity", 429);
      const c: Chat = {
        requestID: randomUUID(),
        input,
        state: "queued",
        createdAt: now(),
        updatedAt: now(),
        result: null,
        error: null,
        events: [],
        expires: Infinity,
        deadline: Date.now() + input.timeoutMs,
      };
      this.chatEvent(c, "queued", {});
      if (slot.instant) {
        const next = structuredClone(this.storage.store);
        next.cooldownUntil = new Date(
          Date.now() + next.config.interactionCooldownMs,
        ).toISOString();
        await this.storage.saveConfig(next);
      }
      this.chats.set(c.requestID, c);
      if (
        slot.instant &&
        this.active?.kind === "run" &&
        !this.instantSlot(this.activeSlot())
      )
        this.active.controller.abort("instant");
      return {
        requestID: c.requestID,
        status: c.state,
        eventsURL: `/v1/chat/requests/${c.requestID}/events`,
        replayed: false,
      };
    });
    this.wake();
    return out;
  }
  async cancelChat(requestID: string, dryRun = false) {
    const c = this.chat(requestID);
    if (terminal(c.state) || dryRun)
      return { requestID, status: c.state, changed: false };
    if (this.active?.id === requestID) {
      this.active.controller.abort("cancelled");
      await this.settling;
    } else {
      c.state = "cancelled";
      c.expires = Date.now() + 900000;
      this.chatEvent(c, "cancelled", {});
    }
    return { requestID, status: c.state, changed: true };
  }
  private wake() {
    if (!this.closed)
      void withoutExecution(() => this.pump()).catch(() => {
        this.presence = {
          state: "present",
          reason: "samplingFailure",
          samplingHealthy: false,
          observedAt: now(),
          diagnostic:
            "Execution or durable checkpoint failed; inspect the run before retrying",
        };
      });
  }
  private async tick() {
    if (this.closed) return;
    if (
      Date.now() - Date.parse(this.presence.observedAt) >= 5000 ||
      !this.presence.samplingHealthy
    ) {
      const wasHealthy = this.presence.samplingHealthy;
      try {
        this.presence = await this.samplePresence();
      } catch {
        this.presence = {
          state: "present",
          reason: "samplingFailure",
          samplingHealthy: false,
          observedAt: now(),
          diagnostic: "Presence sampling failed",
        };
      }
      if (!this.presence.samplingHealthy)
        this.logger?.emit("presence.unhealthy", { reason: "sampling" });
      else if (!wasHealthy) this.logger?.emit("presence.recovered");
    }
    if (
      this.active?.kind === "run" &&
      !this.instantSlot(this.activeSlot()) &&
      (this.presence.state !== "away" || !this.presence.samplingHealthy)
    )
      this.active.controller.abort("presence");
    for (const c of this.chats.values())
      if (!terminal(c.state) && c.deadline <= Date.now()) {
        if (this.active?.id === c.requestID)
          this.active.controller.abort("timedOut");
        else {
          c.state = "timedOut";
          c.expires = Date.now() + 900000;
          this.chatEvent(c, "timedOut", {});
        }
      }
    this.expire();
    this.wake();
  }
  private async pump() {
    if (this.pumping || this.closed || this.runtime.isBusy?.()) return;
    this.pumping = true;
    try {
      const ready = [...this.chats.values()]
        .filter((c) => c.state === "queued")
        .sort((a, b) => Number(this.isInstant(b)) - Number(this.isInstant(a)));
      const candidates = [...this.storage.summaries.values()].filter(
        (r) => r.state === "queued" || r.state === "paused",
      );
      let instantRun: string | undefined;
      for (const candidate of candidates) {
        const run = await this.run(candidate.runID);
        if (this.instantSlot(run.agent.slotID)) {
          instantRun = run.runID;
          break;
        }
      }
      if (ready[0] && this.isInstant(ready[0]))
        this.settling = this.executeChat(ready[0]);
      else if (instantRun) this.settling = this.executeRun(instantRun);
      else if (ready[0]) this.settling = this.executeChat(ready[0]);
      else if (
        this.presence.samplingHealthy &&
        this.presence.state === "away" &&
        Date.now() >=
          (Date.parse(this.storage.store.cooldownUntil ?? "") || 0) &&
        candidates[0]
      )
        this.settling = this.executeRun(candidates[0].runID);
      else return;
      await this.settling;
    } finally {
      if (this.active) this.provisional.delete(this.active.id);
      this.active = undefined;
      this.activeRunSlot = undefined;
      this.pumping = false;
    }
  }
  private instantSlot(slotID: string | undefined) {
    return this.storage.store.config.slots.some(
      (s) => s.slotID === slotID && s.instant,
    );
  }
  // Caller holds the storage lock.
  private async recordInteraction() {
    const next = structuredClone(this.storage.store);
    next.cooldownUntil = new Date(
      Date.now() + next.config.interactionCooldownMs,
    ).toISOString();
    await this.storage.saveConfig(next);
  }
  private isInstant(c: Chat) {
    return this.storage.store.config.slots.some(
      (s) => s.slotID === c.input.slotID && s.instant,
    );
  }
  private async executeChat(c: Chat) {
    const controller = new AbortController();
    this.active = { id: c.requestID, kind: "chat", controller };
    c.state = "running";
    this.chatEvent(c, "started", {});
    const timeout = setTimeout(
      () => controller.abort("timedOut"),
      Math.max(1, c.deadline - Date.now()),
    );
    try {
      c.result = await this.runtime.generate(
        {
          ...c.input,
          thinking: [...c.input.messages]
            .reverse()
            .find((m) => m.role === "user")?.thinking,
        },
        controller.signal,
        this.deltas(c.requestID),
      );
      if (controller.signal.aborted) throw Error("aborted");
      if (Buffer.byteLength(JSON.stringify(c.result)) > 1024 * 1024)
        throw Error("output_limit");
      c.state = "completed";
      this.chatEvent(c, "completed", c.result);
    } catch {
      c.state = controller.signal.aborted
        ? controller.signal.reason === "timedOut"
          ? "timedOut"
          : "cancelled"
        : "failed";
      c.error = { code: c.state, message: "Inference did not complete" };
      this.chatEvent(c, c.state as Event["type"], {});
    } finally {
      clearTimeout(timeout);
      c.expires = Date.now() + 900000;
      if (this.isInstant(c))
        await this.storage.exclusive(async () => {
          const next = structuredClone(this.storage.store);
          next.cooldownUntil = new Date(
            Date.now() + next.config.interactionCooldownMs,
          ).toISOString();
          await this.storage.saveConfig(next);
        });
    }
  }
  private async executeRun(runID: string) {
    const controller = new AbortController();
    this.active = { id: runID, kind: "run", controller };
    const r = await this.storage.exclusive(async () => {
      const value = await this.run(runID);
      this.liveRuns.set(runID, value);
      return value;
    });
    if (terminal(r.state)) {
      this.liveRuns.delete(runID);
      return;
    }
    const configuredSlot = this.storage.store.config.slots.find(
      (s) => s.slotID === r.agent.slotID && s.modelID === r.agent.modelID,
    );
    if (!configuredSlot) {
      r.state = "paused";
      r.pauseReason = "restart";
      r.error = {
        code: "configuration_unavailable",
        message: "Original model and slot configuration is unavailable",
      };
      await this.storage.exclusive(() => this.save(r));
      return;
    }
    this.activeRunSlot = r.agent.slotID;
    r.state = "running";
    r.pauseReason = null;
    this.event(r, "started", {});
    await this.storage.exclusive(() => this.save(r));
    let checkpoint = performance.now();
    let checkpointWork = Promise.resolve();
    const charge = () => {
      const current = performance.now();
      r.activeMs = Math.min(
        r.agent.timeoutMs,
        r.activeMs + Math.ceil(current - checkpoint),
      );
      checkpoint = current;
      if (r.activeMs >= r.agent.timeoutMs) controller.abort("timedOut");
    };
    const timer = setInterval(() => {
      checkpointWork = checkpointWork
        .then(async () => {
          charge();
          await this.storage.exclusive(() => this.save(r));
        })
        .catch(() => controller.abort("storage_failure"));
    }, 1000);
    try {
      while (!controller.signal.aborted) {
        // Resume committed tool calls before requesting another model response.
        const currentMessages = r.messages.slice(
          r.messages.map((m) => m.role).lastIndexOf("user") + 1,
        );
        const lastAssistant = [...currentMessages]
          .reverse()
          .find((m) => m.role === "assistant");
        if (lastAssistant)
          for (const call of lastAssistant.toolCalls) {
            if (r.messages.some((m) => m.toolCallID === call.callID)) continue;
            if (controller.signal.aborted) break;
            const output = await this.invokeTool(
              r,
              call.name,
              call.arguments,
              controller.signal,
            );
            const m: Message = {
              messageID: randomUUID(),
              role: "tool",
              content: JSON.stringify(output),
              attachments: [],
              toolCalls: [],
              toolCallID: call.callID,
            };
            r.messages.push(m);
            this.event(r, "toolResult", { messageID: m.messageID });
            await this.storage.exclusive(() => this.save(r));
          }
        if (controller.signal.aborted) break;
        const result = await this.runtime.generate(
          {
            modelID: r.agent.modelID,
            slotID: r.agent.slotID,
            messages: r.messages,
            tools: (r.toolSnapshots.length
              ? r.toolSnapshots.map((t) => toolDefinitionSchema.parse(t))
              : builtinTools
            )
              .filter((t) =>
                r.agent.toolIDs.includes(t.toolID as typeof toolID._output),
              )
              .map((t) => ({
                name: t.toolID,
                description: t.description,
                parameters: t.parameters,
              })),
            thinking:
              [...r.messages].reverse().find((m) => m.role === "user")
                ?.thinking ?? r.agent.thinking,
            maxOutputTokens: r.agent.maxOutputTokens,
            temperature: r.agent.temperature,
          },
          controller.signal,
          this.deltas(runID),
        );
        if (controller.signal.aborted) break;
        const m: Message = {
          messageID: randomUUID(),
          role: "assistant",
          content: result.text,
          attachments: [],
          toolCalls: result.toolCalls,
          toolCallID: null,
        };
        if (
          Buffer.byteLength(JSON.stringify(r)) +
            Buffer.byteLength(JSON.stringify(m)) >
            56 * 1024 * 1024 ||
          r.messages.length >= 9990 ||
          r.events.length >= 19900
        )
          throw Error("Run capacity");
        r.messages.push(m);
        this.event(r, "message", { messageID: m.messageID });
        if (!result.toolCalls.length) {
          r.state = "completed";
          r.result = result.text;
          this.event(r, "completed", { messageID: m.messageID });
          break;
        }
        if (r.agent.mode === "single-turn") throw Error("Unexpected tools");
        await this.storage.exclusive(() => this.save(r));
      }
    } catch {
      if (!controller.signal.aborted) {
        r.state = "failed";
        r.error = {
          code: "execution_failed",
          message: "Agent execution failed",
        };
        this.event(r, "failed", {});
      }
    } finally {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        r.state =
          reason === "timedOut"
            ? "timedOut"
            : reason === "cancelled"
              ? "cancelled"
              : "paused";
        r.pauseReason =
          r.state === "paused"
            ? reason === "instant"
              ? "instant"
              : reason === "presence"
                ? "presence"
                : "restart"
            : null;
        this.event(r, r.state, {});
      }
      clearInterval(timer);
      await checkpointWork;
      charge();
      if (r.activeMs >= r.agent.timeoutMs && r.state === "completed") {
        r.state = "timedOut";
        r.result = null;
        this.event(r, "timedOut", {});
      }
      await this.storage.exclusive(async () => {
        await this.save(r);
        if (configuredSlot.instant) await this.recordInteraction();
      });
      this.liveRuns.delete(runID);
      if (terminal(r.state)) this.scheduleHooks(r);
    }
  }
  private async invokeTool(
    r: Run,
    name: string,
    args: string,
    signal: AbortSignal,
  ) {
    if (!r.agent.toolIDs.includes(name as typeof toolID._output))
      throw Error("Tool denied");
    const definition = (
      r.toolSnapshots.length
        ? r.toolSnapshots.map((t) => toolDefinitionSchema.parse(t))
        : builtinTools
    ).find((t) => t.toolID === name);
    if (!definition || !this.tools.has(name))
      throw Error("Tool no longer available");
    const input: unknown = JSON.parse(args);
    if (definition.adapter === "exec")
      return executeExternalTool(definition, input, signal);
    name = definition.adapter;
    let result: unknown;
    if (name === "load_skills") {
      const x = z
        .strictObject({ skillIDs: z.array(z.string()).max(40) })
        .parse(input);
      result = x.skillIDs.map(
        (id) =>
          r.skills.find((s) => s.skillID === id) ?? fail("skill_denied", 403),
      );
    } else if (name === "runs_list") {
      const x = z
        .strictObject({ limit: z.number().int().min(1).max(100).default(20) })
        .parse(input);
      result = (await this.listRuns(r.agent.agentID)).slice(-x.limit);
    } else {
      const x = z
        .strictObject({
          runID: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .parse(input);
      const other = await this.run(x.runID);
      if (other.agent.agentID !== r.agent.agentID)
        throw Error("History denied");
      result = this.transcript(other).slice(x.offset, x.offset + x.limit);
    }
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
      throw Error("Tool output limit");
    return result;
  }
  private async deliverHooks(r: Run) {
    const eventName = `run.${r.state}`;
    const event = [...r.events].reverse().find((e) => e.type === r.state);
    if (!event) return;
    for (const hook of this.storage.store.config.hooks.filter(
      (h) => h.event === eventName,
    )) {
      const accepted = await this.storage.exclusive(async () => {
        const current = this.liveRuns.get(r.runID) ?? (await this.run(r.runID));
        if (
          current.hookReceipts.some(
            (h) =>
              h.eventSequence === event.sequence &&
              h.executablePath === hook.executablePath,
          )
        )
          return false;
        current.hookReceipts.push({
          eventSequence: event.sequence,
          executablePath: hook.executablePath,
          status: "started",
          diagnostic: null,
        });
        await this.save(current);
        return true;
      });
      if (!accepted) continue;
      const ok = await new Promise<boolean>((resolve) => {
        const child = spawn(hook.executablePath, [], {
          stdio: ["pipe", "ignore", "ignore"],
          env: { PATH: process.env.PATH ?? "" },
          detached: true,
        });
        let finished = false;
        const done = (value: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve(value);
        };
        const timer = setTimeout(() => {
          if (child.pid)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
        }, hook.timeoutMs);
        child.once("error", () => done(false));
        child.once("exit", (code) => done(code === 0));
        child.stdin.on("error", () => {});
        child.stdin.end(
          JSON.stringify({
            version: 1,
            event: eventName,
            runID: r.runID,
            agentID: r.agent.agentID,
            segment: r.segment,
            state: r.state,
            result: r.result,
            error: r.error,
          }) + "\n",
        );
      });
      await this.storage.exclusive(async () => {
        const current = this.liveRuns.get(r.runID) ?? (await this.run(r.runID));
        const receipt = current.hookReceipts.find(
          (h) =>
            h.eventSequence === event.sequence &&
            h.executablePath === hook.executablePath,
        )!;
        receipt.status = ok ? "succeeded" : "failed";
        receipt.diagnostic = ok ? null : "Hook failed or timed out";
        // Delivery may settle after a follow-up begins; retain its originating segment.
        current.events.push({
          sequence: current.events.length + 1,
          at: now(),
          type: "hookResult",
          segment: event.segment,
          data: { eventSequence: event.sequence, status: receipt.status },
        });
        await this.save(current);
      });
    }
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.active?.controller.abort("restart");
    await this.settling;
    await this.runtime.close();
    await Promise.all(this.hookWork);
    await this.storage.close();
  }
}
