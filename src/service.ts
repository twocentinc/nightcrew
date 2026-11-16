import {
  loopProblem,
  validateOutput,
  reviewFingerprint,
} from "./supervision.js";
import {
  compactionInstructions,
  validateSummaryEvidence,
  contextMessages,
  compactionBoundary,
  compactionRequest,
  executeCompactionScript,
  summarySchema,
  parseCompactionSummary,
} from "./compaction.js";
import {
  executionSlots,
  instantModelID,
  policyPlan,
  validatePlan,
  type SchedulerSnapshot,
} from "./scheduler.js";
import { withSkillCatalog } from "./skills.js";
import { nextFireAt } from "./triggers.js";
import type { OperationalLog } from "./logging.js";
import { checkpoint, withoutExecution } from "./execution.js";
import {
  builtinTools,
  loadRegistry,
  validateRegistry,
  normalizeStoredTool,
  executeModelTool,
  type ToolDefinition,
} from "./registry.js";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  agentSchema,
  attemptSchema,
  runSchema,
  triggerSourceSchema,
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
  outputLimitReached?: boolean;
  text: string;
  reasoningContent?: string;
  toolCalls: Message["toolCalls"];
  usage: { inputTokens: number; outputTokens: number };
};
export type Attempt = z.infer<typeof attemptSchema>;
export type PartialOutput = Pick<Attempt, "reasoningContent" | "toolCalls">;
export interface Runtime {
  initialize?(): Promise<void>;
  countTokens?(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
  ): Promise<number>;
  keepWarm?(until: number): void;
  contextCache?(
    contextID: string,
    reset: boolean,
    dryRun: boolean,
  ): Promise<unknown>;
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
      contextID?: string;
      persistContext?: boolean;
      contextEpoch?: number;
      messages: Message[];
      tools: ChatInput["tools"];
      thinking?: boolean;
      reasoningBudgetTokens?: number;
      continueOnOutputLimit?: boolean;
      continueFinalMessage?: boolean;
      maxOutputTokens: number;
      temperature: number;
      sampling?: Agent["sampling"];
    },
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onEvidence?: (output: PartialOutput) => void,
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
  evalOptions?: { sampling?: Agent["sampling"] };
  requestID: string;
  input: ChatInput & { modelID: string };
  skills: Skill[];
  messages: Message[];
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
  private responseContinuation(run: Run) {
    const chunks: Attempt[] = [];
    for (const attempt of [...run.attempts].reverse()) {
      if (attempt.segment !== run.segment || attempt.messageID) break;
      if (attempt.reason === "output_limit") chunks.unshift(attempt);
    }
    return chunks;
  }
  private runMessages(
    run: Run,
    checkpoint?: Parameters<typeof contextMessages>[1],
  ) {
    const messages = contextMessages(run, checkpoint);
    return run.agent.mode === "agent-loop"
      ? withSkillCatalog(messages, run.skills)
      : messages;
  }
  private agentToolIDs(agent: Agent) {
    return [
      ...new Set([
        ...agent.toolIDs,
        ...(agent.mode === "agent-loop" ? ["load_skills"] : []),
      ]),
    ];
  }
  private runTools(run: Run) {
    const selected = this.agentToolIDs(run.agent);
    const snapshots = run.toolSnapshots.map(normalizeStoredTool);
    return selected.map(
      (id) =>
        snapshots.find((t) => t.toolID === id) ??
        this.tools.get(id) ??
        fail("tool_not_found"),
    );
  }
  async reloadRegistry(dryRun = false) {
    const registry = await loadRegistry(this.storage.home);
    validateRegistry(
      this.storage.store.agents,
      registry.skills,
      registry.tools,
    );
    const result = { skills: registry.skills.size, tools: registry.tools.size };
    if (dryRun) return result;
    this.skills.clear();
    for (const [id, s] of registry.skills) this.skills.set(id, s);
    this.tools.clear();
    for (const [id, t] of registry.tools) this.tools.set(id, t);
    return result;
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
  private scheduleHooks(run: Run, eventType?: string) {
    const task = withoutExecution(() =>
      this.deliverHooks(run, eventType),
    ).catch(() => {});
    this.hookWork.add(task);
    void task.finally(() => this.hookWork.delete(task));
  }
  private timer?: ReturnType<typeof setInterval>;
  private pumping = false;
  private closed = false;
  private activities = new Map<
    string,
    {
      id: string;
      kind: "run" | "chat";
      controller: AbortController;
      slotID: string;
      modelID: string;
      task: Promise<void>;
    }
  >();
  private get active() {
    return this.activities.values().next().value;
  }
  private get settling() {
    return Promise.all([...this.activities.values()].map((a) => a.task));
  }
  private residentSince = Date.now();
  private residentModelID: string | null = null;
  private triggerDue = new Map<string, { revision: number; at: number }>();
  private ticking = false;
  private lastDecision: unknown = null;
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
          for (const attempt of r.attempts)
            if (attempt.status === "running") {
              attempt.status = "interrupted";
              attempt.reason = "restart";
              attempt.updatedAt = now();
              changed = true;
            }
          if (!terminal(r.state) && r.state !== "queued") {
            r.state = "paused";
            if (
              r.pauseReason !== "storage_limit" &&
              r.pauseReason !== "runtime_error" &&
              r.pauseReason !== "context_full"
            )
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
          this.logger?.emit("scheduler.tickFailed", { reason: "process" });
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
  publicConfig(
    config: Omit<Config, "rootTokenHash"> & { rootTokenHash?: string } = this
      .storage.store.config,
  ) {
    const { rootTokenHash, models, hooks, ...rest } = config;
    return {
      ...rest,
      models: models.map(({ weightsPath, projectorPath, ...model }) => model),
      hooks: hooks.map(({ event, timeoutMs, purpose }) => ({
        event,
        timeoutMs,
        purpose,
      })),
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
            blockingReason: x.held ? "held" : x.pauseReason,
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
      slots: executionSlots(this.storage.store.config).map((s) => ({
        ...s,
        busy: [...this.activities.values()].some((a) => a.slotID === s.slotID),
        conversationID:
          this.active?.kind === "chat"
            ? (this.chats.get(this.active.id)?.input.conversationID ?? null)
            : null,
      })),
    };
  }
  private activeSlot() {
    return this.active?.slotID;
  }
  private interruptBackground(reason: string) {
    for (const a of this.activities.values())
      if (a.kind === "run" && !this.runInteractive(this.liveRuns.get(a.id)))
        a.controller.abort(reason);
  }
  private runInteractive(run: Run | undefined) {
    return (
      !!run &&
      run.agent.modelID === instantModelID(this.storage.store.config) &&
      (run.interactive ?? this.instantSlot(run.agent.slotID))
    );
  }
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
      reviews: r.reviews,
      validations: r.validations,
      recovery: r.recovery,
      compactions: r.compactions,
      compaction: r.compaction,
      parentRunID: r.parentRunID,
      agent: r.agent,
      triggerSource: r.triggerSource,
      pendingInputs: r.pendingInputs,
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
      if (
        skill.toolIDs.some((t) => t !== "load_skills" && !a.toolIDs.includes(t))
      )
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
      if (agent.contextMode === "persistent") {
        const model = next.config.models.find(
          (m) => m.modelID === agent.modelID,
        );
        if (model && model.kind === "chat" && !model.slotSnapshots.enabled) {
          model.slotSnapshots.enabled = true;
          next.config.revision++;
        }
      }
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
      if (agent.contextMode === "persistent") {
        const model = next.config.models.find(
          (m) => m.modelID === agent.modelID,
        );
        if (model && model.kind === "chat" && !model.slotSnapshots.enabled) {
          model.slotSnapshots.enabled = true;
          next.config.revision++;
        }
      }
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
      attempt:
        e.data &&
        typeof e.data === "object" &&
        !Array.isArray(e.data) &&
        "attemptID" in e.data
          ? (r.attempts.find(
              (a) =>
                a.attemptID === (e.data as { attemptID: string }).attemptID,
            ) ?? null)
          : null,
      message:
        e.data &&
        typeof e.data === "object" &&
        !Array.isArray(e.data) &&
        "messageID" in e.data
          ? ([
              ...r.messages,
              ...r.pendingInputs.map((p) => ({
                ...p.message,
                role: "user" as const,
                toolCalls: [],
                toolCallID: null,
              })),
            ].find(
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
          (e.message && "reasoningContent" in e.message
            ? (e.message.reasoningContent ?? "")
            : "") +
          (e.attempt?.text ?? "") +
          (e.attempt?.reasoningContent ?? "") +
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
    if (reply && this.activities.has(target))
      await this.activities.get(target)!.task;
    const out = await this.storage.exclusive(() =>
      this.submitLocked(target, message, reply, dryRun),
    );
    if (!dryRun) this.wake();
    return out;
  }
  private async submitLocked(
    target: string,
    message: UserMessage,
    reply: boolean,
    dryRun: boolean,
    source: z.infer<typeof triggerSourceSchema> | null = null,
    retryNote?: string,
  ) {
    await this.storage.reconcile();
    if (this.storage.unreadable.length) fail("run_index_unavailable", 503);
    const existing = this.storage.messages.get(message.messageID);
    if (existing) {
      const r = await this.run(existing.runID);
      const m = [
        ...r.messages,
        ...r.pendingInputs.map((p) => ({
          ...p.message,
          role: "user" as const,
          toolCalls: [],
          toolCallID: null,
        })),
      ][existing.index]!;
      if (
        (reply
          ? r.runID !== target ||
            (r.agent.contextMode !== "persistent" && existing.index === 1)
          : r.agent.agentID !== target ||
            (r.agent.contextMode !== "persistent" && existing.index !== 1)) ||
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
    let previous = reply ? await this.run(target) : null;
    const configuredAgent = reply
      ? previous!.agent.contextMode === "persistent"
        ? this.agent(previous!.agent.agentID)
        : previous!.agent
      : this.agent(target);
    if (!previous && configuredAgent.contextMode === "persistent") {
      const persistentID =
        "persistent-" + createHash("sha256").update(target).digest("hex");
      if (this.storage.summaries.has(persistentID))
        previous =
          this.liveRuns.get(persistentID) ?? (await this.run(persistentID));
    }
    const a =
      previous?.agent.contextMode === "persistent"
        ? configuredAgent
        : (previous?.agent ?? configuredAgent);
    if (
      previous &&
      (previous.pauseReason === "storage_limit" ||
        this.atStorageLimit(previous))
    ) {
      if (!dryRun && !this.activities.has(previous.runID)) {
        this.pauseForStorage(previous);
        await this.save(previous);
        this.scheduleHooks(previous);
      }
      fail("run_storage_limit", 409);
    }
    if (
      previous &&
      a.contextMode === "persistent" &&
      (!terminal(previous.state) ||
        previous.pendingInputs.some((p) => !p.cancelled))
    ) {
      this.checkMessage(message, a.modelID);
      if (
        previous.pendingInputs.length >= 1000 ||
        previous.pendingInputs.filter((p) => !p.cancelled).length >= 100
      )
        fail("pending_input_capacity", 429);
      const pending: Run["pendingInputs"][number] = {
        message,
        cancelled: false,
        source,
        agent: structuredClone(a),
        skills: a.skillIDs.map((id) => structuredClone(this.skills.get(id)!)),
        tools: this.agentToolIDs(a).map((id) =>
          JSON.parse(JSON.stringify(this.tools.get(id))),
        ),
      };
      // Reject oversized pending input before mutating an actively executing run.
      if (
        Buffer.byteLength(JSON.stringify(previous)) +
          Buffer.byteLength(JSON.stringify(pending)) >
        56 * 1024 * 1024
      )
        fail("run_capacity", 507);
      if (!dryRun) {
        previous.pendingInputs.push(pending);
        this.event(previous, "pendingInput", { messageID: message.messageID });
        await this.save(previous);
      }
      return this.acceptance(previous, false);
    }
    this.checkMessage(message, a.modelID);
    if (reply && !message.content.trim() && !message.attachments.length)
      fail("empty_reply");
    if (
      previous &&
      a.contextMode !== "persistent" &&
      previous.state !== "completed" &&
      !retryNote
    )
      fail("run_not_completed", 409);
    const r: Run = previous ?? {
      reviews: [],
      deliveryExpected: false,
      validations: [],
      recovery: null,
      attempts: [],
      compactions: [],
      compaction: null,
      parentRunID: null,
      version: 2,
      held: false,
      interactive: source?.admission !== "timer" && this.instantSlot(a.slotID),
      pendingInputs: [],
      triggerHistory: [],
      triggerSource: source,
      toolSnapshots: this.agentToolIDs(a).map((id) =>
        JSON.parse(JSON.stringify(this.tools.get(id))),
      ),
      runID:
        a.contextMode === "persistent"
          ? "persistent-" + createHash("sha256").update(a.agentID).digest("hex")
          : randomUUID(),
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
      r.agent = structuredClone(a);
      r.skills = a.skillIDs.map((id) => structuredClone(this.skills.get(id)!));
      r.toolSnapshots = this.agentToolIDs(a).map((id) =>
        JSON.parse(JSON.stringify(this.tools.get(id))),
      );
      r.interactive =
        source?.admission !== "timer" && this.instantSlot(a.slotID);
      if (source) r.triggerHistory.push(source);
      r.deliveryExpected = false;
      r.segment++;
      if (retryNote) {
        r.held = false;
        r.compaction = null;
        this.event(r, "retried", {
          previousSegment: r.segment - 1,
          messageID: message.messageID,
          note: retryNote,
        });
      }
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
      if (this.runInteractive(r)) {
        await this.recordInteraction();
        this.interruptBackground("instant");
      }
    }
    return this.acceptance(r, false);
  }
  async fireTrigger(
    triggerID: string,
    occurrenceID: string,
    replacement: Omit<UserMessage, "messageID"> | undefined,
    dryRun: boolean,
    scheduled = false,
  ) {
    const hash = (input: Omit<UserMessage, "messageID">) =>
      createHash("sha256").update(canonical(input)).digest("hex");
    const outcome = await this.storage.exclusive(async () => {
      await this.storage.reconcile();
      if (this.storage.unreadable.length) fail("run_index_unavailable", 503);
      const related: Run[] = [];
      for (const summary of this.storage.summaries.values()) {
        const run = await this.run(summary.runID);
        const sources = [
          run.triggerSource,
          ...run.triggerHistory,
          ...run.pendingInputs.map((p) => p.source),
        ].filter((x): x is NonNullable<typeof x> => !!x);
        const matched = sources.find((x) =>
          x.occurrences.some((o) => o.occurrenceID === occurrenceID),
        );
        const occurrence = matched?.occurrences.find(
          (o) => o.occurrenceID === occurrenceID,
        );
        if (occurrence) {
          if (
            matched!.definition.triggerID !== triggerID ||
            (replacement && hash(replacement) !== occurrence.inputHash)
          )
            fail("message_conflict", 409);
          return {
            outcome: "replayed",
            runID: run.runID,
            occurrenceID,
            changed: false,
          };
        }
        if (
          sources.some((source) => source.definition.triggerID === triggerID) &&
          !terminal(run.state)
        )
          related.push(run);
      }
      if (this.storage.messages.has(occurrenceID))
        fail("message_conflict", 409);
      const trigger =
        this.storage.store.triggers.find((t) => t.triggerID === triggerID) ??
        fail("trigger_not_found", 404);
      if (!trigger.enabled) fail("trigger_disabled", 409);
      const agent = this.agent(trigger.agentID);
      if (!agent.enabled) fail("agent_disabled", 409);
      const input = replacement ?? trigger.message;
      const message = { ...input, messageID: occurrenceID };
      this.checkMessage(message, agent.modelID);
      if (trigger.queuePolicy === "skip" && related.length)
        return {
          outcome: "skipped",
          runID: related[0]!.runID,
          occurrenceID,
          changed: false,
        };
      const occurrence = { occurrenceID, inputHash: hash(input) };
      if (trigger.queuePolicy === "coalesce") {
        for (const candidate of related) {
          const run = this.liveRuns.get(candidate.runID) ?? candidate;
          const old = run.pendingInputs.find(
            (p) =>
              !p.cancelled &&
              p.source?.definition.triggerID === triggerID &&
              p.source.definition.revision === trigger.revision &&
              p.agent?.revision === agent.revision,
          );
          if (old) {
            if (run.pendingInputs.length >= 1000)
              fail("pending_input_capacity", 429);
            if (!dryRun) {
              old.cancelled = true;
              run.pendingInputs.push({
                message,
                cancelled: false,
                source: {
                  definition: structuredClone(trigger),
                  admission: scheduled ? "timer" : "manual",
                  occurrences: [occurrence],
                },
                agent: structuredClone(agent),
                skills: old.skills,
                tools: old.tools,
              });
              this.event(run, "pendingInput", { messageID: occurrenceID });
              this.event(run, "coalesced", { messageID: occurrenceID });
              await this.save(run);
            }
            return {
              outcome: "coalesced",
              runID: run.runID,
              occurrenceID,
              changed: !dryRun,
            };
          }
        }
      }

      const pending =
        trigger.queuePolicy === "coalesce"
          ? related.find(
              (r) =>
                (r.state === "queued" || r.state === "paused") &&
                !this.activities.has(r.runID) &&
                !r.events.some((e) => e.type === "started") &&
                r.triggerSource!.definition.revision === trigger.revision &&
                r.agent.revision === agent.revision,
            )
          : undefined;
      if (pending) {
        if (pending.triggerSource!.occurrences.length >= 1000)
          fail("occurrence_capacity", 429);
        pending.triggerSource!.occurrences.push(occurrence);
        pending.messages.push({
          ...message,
          role: "user",
          toolCalls: [],
          toolCallID: null,
        });
        this.event(pending, "message", { messageID: occurrenceID });
        this.event(pending, "coalesced", { messageID: occurrenceID });
        if (Buffer.byteLength(JSON.stringify(pending)) > 56 * 1024 * 1024)
          fail("run_capacity", 507);
        if (!dryRun) await this.save(pending);
        return {
          outcome: "coalesced",
          runID: pending.runID,
          occurrenceID,
          changed: !dryRun,
        };
      }
      const accepted = await this.submitLocked(
        trigger.agentID,
        message,
        false,
        dryRun,
        {
          definition: structuredClone(trigger),
          admission: scheduled ? "timer" : "manual",
          occurrences: [occurrence],
        },
      );
      return {
        outcome: "queued",
        runID: accepted.runID,
        occurrenceID,
        changed: !dryRun,
      };
    });
    if (!dryRun && outcome.changed) this.wake();
    return outcome;
  }
  async reviewRun(
    runID: string,
    input: {
      expectedRevision: number;
      status: "open" | "acknowledged" | "resolved";
      note: string;
    },
    dryRun: boolean,
  ) {
    return this.storage.exclusive(async () => {
      const run = await this.run(runID);
      if (run.revision !== input.expectedRevision)
        fail("revision_conflict", 409);
      if (this.activities.has(runID)) fail("run_active", 409);
      if (run.reviews.length >= 1000) fail("review_capacity", 409);
      if (!dryRun) {
        run.reviews.push({
          segment: run.segment,
          status: input.status,
          note: input.note,
          at: now(),
          fingerprint: reviewFingerprint(run),
        });
        this.event(run, "reviewed", { status: input.status, note: input.note });
        await this.save(run);
      }
      return { run: this.detail(run), changed: !dryRun };
    });
  }
  async retryRun(
    runID: string,
    input: { expectedRevision: number; messageID: string; note: string },
    dryRun: boolean,
  ) {
    const result = await this.storage.exclusive(async () => {
      const run = await this.run(runID);
      const prior = run.events.find(
        (e) =>
          e.type === "retried" &&
          (e.data as { messageID?: string })?.messageID === input.messageID,
      );
      if (prior) {
        if ((prior.data as { note: string }).note !== input.note)
          fail("message_conflict", 409);
        return this.acceptance(run, true);
      }
      if (run.revision !== input.expectedRevision)
        fail("revision_conflict", 409);
      if (!terminal(run.state) || this.activities.has(runID))
        fail("run_not_terminal", 409);
      if (run.parentRunID) fail("compactor_retry_requires_parent", 409);
      if (run.pendingInputs.some((p) => !p.cancelled))
        fail("pending_inputs_exist", 409);
      const previous = run.messages.filter((m) => m.role === "user").at(-1);
      if (!previous) fail("message_missing", 409);
      return this.submitLocked(
        runID,
        {
          messageID: input.messageID,
          content: previous.content,
          attachments: previous.attachments,
          ...(previous.thinking === undefined
            ? {}
            : { thinking: previous.thinking }),
        },
        true,
        dryRun,
        null,
        input.note,
      );
    });
    if (!dryRun) this.wake();
    return result;
  }
  async retryHook(
    runID: string,
    input: {
      expectedRevision: number;
      receiptIndex: number;
      requestID: string;
      note: string;
      acceptUnknown: boolean;
      hookPath?: string;
    },
    dryRun: boolean,
  ) {
    const result = await this.storage.exclusive(async () => {
      const run = await this.run(runID);
      const prior = run.hookReceipts.find(
        (h) => h.requestID === input.requestID,
      );
      if (prior) {
        if (
          prior.retryOf !== input.receiptIndex ||
          prior.note !== input.note ||
          (input.hookPath && prior.executablePath !== input.hookPath)
        )
          fail("request_conflict", 409);
        return { run: this.detail(run), changed: false, index: null };
      }
      if (run.revision !== input.expectedRevision)
        fail("revision_conflict", 409);
      if (!terminal(run.state) || this.activities.has(runID))
        fail("run_not_terminal", 409);
      const receipt = run.hookReceipts[input.receiptIndex];
      if (!receipt || !["failed", "unknown"].includes(receipt.status))
        fail("hook_not_retryable", 409);
      if (run.hookReceipts.some((h) => h.retryOf === input.receiptIndex))
        fail("hook_already_retried", 409);
      if (receipt.status === "unknown" && !input.acceptUnknown)
        fail("hook_outcome_unknown", 409);
      const event = run.events.find(
        (e) => e.sequence === receipt.eventSequence,
      );
      if (!event || event.segment !== run.segment)
        fail("hook_segment_changed", 409);
      const original = await realpath(receipt.executablePath).catch(
        () => receipt.executablePath,
      );
      const candidates = this.storage.store.config.hooks.filter(
        (h) => h.event === `run.${event.type}` && h.purpose === receipt.purpose,
      );
      let hook;
      for (const candidate of candidates) {
        if (
          input.hookPath
            ? candidate.executablePath === input.hookPath
            : (await realpath(candidate.executablePath).catch(
                () => candidate.executablePath,
              )) === original
        ) {
          hook = candidate;
          break;
        }
      }
      if (!hook) fail("hook_not_registered", 409);
      if (run.hookReceipts.length >= 1000) fail("hook_receipt_capacity", 409);
      const index = run.hookReceipts.length;
      if (!dryRun) {
        run.hookReceipts.push({
          ...receipt,
          executablePath: hook.executablePath,
          requestID: input.requestID,
          retryOf: input.receiptIndex,
          note: input.note,
          status: "pending",
          diagnostic: null,
        });
        await this.save(run);
      }
      return {
        run: this.detail(run),
        changed: !dryRun,
        index: dryRun ? null : index,
      };
    });
    if (result.index !== null) {
      const work = withoutExecution(async () =>
        this.deliverHooks(await this.run(runID), undefined, result.index!),
      );
      this.hookWork.add(work);
      try {
        await work;
      } finally {
        this.hookWork.delete(work);
      }
    }
    return { run: this.detail(await this.run(runID)), changed: result.changed };
  }
  async pauseRun(runID: string, expectedRevision: number, dryRun: boolean) {
    const run = await this.run(runID);
    if (run.revision !== expectedRevision) fail("revision_conflict", 409);
    if (terminal(run.state)) fail("run_not_pending", 409);
    const activity = this.activities.get(runID);
    if (activity) {
      if (dryRun) return {run:this.detail(run),changed:false};
      // Set the live hold before aborting so the scheduler cannot restart it.
      const live = this.liveRuns.get(runID);
      if (live) live.held = true;
      activity.controller.abort("manual");
      await activity.task;
      return {run:this.detail(await this.run(runID)),changed:true};
    }
    return this.queueControl(runID, "hold", expectedRevision, dryRun);
  }
  async queueControl(
    runID: string,
    action: "hold" | "release" | "cancel",
    expectedRevision: number,
    dryRun: boolean,
  ) {
    const result = await this.storage.exclusive(async () => {
      const run = await this.run(runID);
      if (run.revision !== expectedRevision) fail("revision_conflict", 409);
      if (
        this.activities.has(runID) ||
        (run.state !== "queued" && run.state !== "paused")
      )
        fail("run_not_pending", 409);
      const changed = action === "cancel" || run.held !== (action === "hold");
      if (changed && !dryRun) {
        if (action === "cancel") {
          run.state = "cancelled";
          for (const p of run.pendingInputs) p.cancelled = true;
          run.pauseReason = null;
          this.event(run, "cancelled", {});
        } else {
          if (action === "release" && run.pauseReason === "storage_limit") {
            const updated = {
              ...run,
              agent: {
                ...run.agent,
                storageLimitMB: this.agent(run.agent.agentID).storageLimitMB,
              },
            };
            if (this.atStorageLimit(updated)) fail("run_storage_limit", 409);
            run.agent.storageLimitMB = updated.agent.storageLimitMB;
            const boundary = [...run.events]
              .reverse()
              .find((e) => e.type === "storageLimit");
            const prior = (
              boundary?.data as { previousState?: Run["state"] } | null
            )?.previousState;
            if (prior && terminal(prior)) run.state = prior;
            run.pauseReason = null;
            run.error = null;
          }
          run.held = action === "hold";
          if (action === "release" && run.pauseReason === "context_full") {
            run.compaction = null;
            run.agent.compaction = structuredClone(
              this.agent(run.agent.agentID).compaction,
            );
            run.error = null;
            run.pauseReason = null;
          }
          if (action === "release" && run.pauseReason === "runtime_error") {
            if (run.compaction?.childRunID) {
              const child = await this.run(run.compaction.childRunID);
              if (child.pauseReason === "runtime_error") {
                child.held = false;
                child.pauseReason = null;
                child.error = null;
                this.event(child, "released", { parentRunID: run.runID });
                await this.save(child);
              }
            }
            run.error = null;
            run.pauseReason = null;
          }
          this.event(run, run.held ? "held" : "released", {});
        }
        await this.save(run);
      }
      return { run: this.detail(run), changed: changed && !dryRun };
    });
    if (result.changed && action === "cancel")
      this.scheduleHooks(await this.run(runID));
    if (result.changed) this.wake();
    return result;
  }
  async cancelRun(runID: string, dryRun = false) {
    const r = await this.run(runID);
    if (terminal(r.state) || dryRun)
      return { runID, status: r.state, changed: false };
    if (this.activities.has(runID)) {
      this.activities.get(runID)!.controller.abort("cancelled");
      await this.activities.get(runID)!.task;
      return { runID, status: (await this.run(runID)).state, changed: true };
    }
    const outcome = await this.storage.exclusive(async () => {
      const current = await this.run(runID);
      if (terminal(current.state))
        return { runID, status: current.state, changed: false };
      current.state = "cancelled";
      for (const p of current.pendingInputs) p.cancelled = true;
      current.pauseReason = null;
      this.event(current, "cancelled", {});
      await this.save(current);
      return { runID, status: current.state, changed: true };
    });
    if (outcome.changed) {
      this.scheduleHooks(await this.run(runID));
      this.wake();
    }
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
      messages: c.messages,
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
  async submitChat(request: ChatInput, evalOptions?: { sampling?: Agent["sampling"] }) {
    const out = await this.storage.exclusive(async () => {
      await this.storage.reconcile();
      this.expire();
      const modelID =
        instantModelID(this.storage.store.config) ??
        fail("instant_model_not_configured");
      if (request.modelID !== undefined && request.modelID !== modelID)
        fail("invalid_instant_model");
      const input = { ...request, skillIDs: request.skillIDs ?? [], modelID };
      if (new Set(input.skillIDs).size !== input.skillIDs.length)
        fail("duplicate_identity");
      if (!evalOptions && input.tools.some((t) => t.name === "load_skills"))
        fail("reserved_tool_name");
      const selectedSkills = (evalOptions ? [] : input.skillIDs).map((id) =>
        structuredClone(this.skills.get(id) ?? fail("skill_not_found", 404)),
      );
      if (
        selectedSkills.some((s) =>
          s.toolIDs.some(
            (id) =>
              id !== "load_skills" && !input.tools.some((t) => t.name === id),
          ),
        )
      )
        fail("skill_tool_not_allowed");

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
        if (canonical(old.input) !== canonical(input) || canonical(old.evalOptions ?? null) !== canonical(evalOptions ?? null))
          fail("message_conflict", 409);
        return {
          requestID: old.requestID,
          status: old.state,
          eventsURL: `/v1/chat/requests/${old.requestID}/events`,
          replayed: true,
        };
      }
      const slot =
        executionSlots(this.storage.store.config).find(
          (s) =>
            (s.slotID === input.slotID ||
              (input.slotID === "instant" && s.instant)) &&
            s.instant &&
            s.modelID === input.modelID,
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
        Buffer.byteLength(JSON.stringify({ input, selectedSkills })) >
          6 * 1024 * 1024
      )
        fail("request_capacity", 429);
      const c: Chat = {
        ...(evalOptions ? { evalOptions } : {}),
        requestID: randomUUID(),
        input,
        skills: selectedSkills,
        messages: [],
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
      if (slot.instant) this.interruptBackground("instant");
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
    if (this.activities.has(requestID)) {
      this.activities.get(requestID)!.controller.abort("cancelled");
      await this.activities.get(requestID)!.task;
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
        this.logger?.emit("scheduler.pumpFailed", { reason: "process" });
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
    if (this.presence.state !== "away" || !this.presence.samplingHealthy)
      this.interruptBackground("presence");
    for (const c of this.chats.values())
      if (!terminal(c.state) && c.deadline <= Date.now()) {
        const active = this.activities.get(c.requestID);
        if (active) active.controller.abort("timedOut");
        else {
          c.state = "timedOut";
          c.expires = Date.now() + 900000;
          this.chatEvent(c, "timedOut", {});
        }
      }
    await this.dispatchTimers();
    this.runtime.keepWarm?.(
      Date.parse(this.storage.store.cooldownUntil ?? "") || 0,
    );
    this.expire();
    this.wake();
  }
  async schedulerSnapshot(): Promise<SchedulerSnapshot> {
    const config = this.storage.store.config;
    const blockers: string[] = [];
    if (!this.presence.samplingHealthy || this.presence.state !== "away")
      blockers.push("desktop_present_or_unknown");
    if (Date.parse(this.storage.store.cooldownUntil ?? "") > Date.now())
      blockers.push("interaction_cooldown");
    if (
      [...this.activities.values()].some(
        (a) =>
          a.kind === "chat" || this.runInteractive(this.liveRuns.get(a.id)),
      )
    )
      blockers.push("instant_work");
    if ([...this.chats.values()].some((c) => c.state === "queued"))
      blockers.push("interactive_queue");
    const pending = [];
    const dependencyIDs = new Set<string>();
    for (const summary of await this.listRuns()) {
      if (
        summary.held ||
        this.activities.has(summary.runID) ||
        !["queued", "paused"].includes(summary.state)
      )
        continue;
      const run = await this.run(summary.runID);
      if (run.parentRunID) {
        const parent = await this.run(run.parentRunID);
        if (
          parent.held ||
          terminal(parent.state) ||
          parent.compaction?.childRunID !== run.runID
        )
          continue;
      }
      if (
        run.compaction?.status === "waiting" ||
        run.compaction?.status === "failed"
      )
        continue;
      if (this.runInteractive(run)) {
        blockers.push("instant_queue");
        continue;
      }
      if (run.parentRunID) dependencyIDs.add(run.runID);
      const since =
        [...run.events]
          .reverse()
          .find((e) => ["queued", "paused"].includes(e.type))?.at ??
        run.createdAt;
      pending.push({
        runID: run.runID,
        modelID: run.agent.modelID,
        priority: run.agent.priority,
        modelPriority:
          config.models.find((m) => m.modelID === run.agent.modelID)
            ?.priority ?? 0,
        waitingSince: Date.parse(since),
      });
    }
    return {
      now: Date.now(),
      eligible: !blockers.length,
      blockers,
      residentModelID: this.residentModelID,
      residentSince: this.residentSince,
      settings: config.scheduler,
      pending: pending.some(
        (p) =>
          this.storage.summaries.has(p.runID) && dependencyIDs.has(p.runID),
      )
        ? pending.filter((p) => dependencyIDs.has(p.runID))
        : pending,
      active: [...this.activities.values()]
        .filter(
          (a) =>
            a.kind === "run" && !this.runInteractive(this.liveRuns.get(a.id)),
        )
        .map(({ id, modelID, slotID }) => ({ runID: id, modelID, slotID })),
      slots: executionSlots(config)
        .filter((s) => !s.instant)
        .map(({ slotID, modelID }) => ({ slotID, modelID })),
    };
  }
  async explainScheduler() {
    const snapshot = await this.schedulerSnapshot();
    return { snapshot, ...(await policyPlan(snapshot)) };
  }
  schedulerStatus() {
    return {
      instantModelID: instantModelID(this.storage.store.config),
      active: [...this.activities.values()].map(
        ({ id, kind, slotID, modelID }) => ({ id, kind, slotID, modelID }),
      ),
      residentModelID: this.residentModelID,
      lastDecision: this.lastDecision,
    };
  }
  private launch(
    id: string,
    kind: "run" | "chat",
    slotID: string,
    modelID: string,
  ) {
    const controller = new AbortController();
    if (this.residentModelID !== modelID) {
      this.residentModelID = modelID;
      this.residentSince = Date.now();
    }
    const activity = {
      id,
      kind,
      controller,
      slotID,
      modelID,
      task: Promise.resolve(),
    };
    this.activities.set(id, activity);
    activity.task = Promise.resolve()
      .then(() =>
        kind === "run"
          ? this.executeRun(id, slotID, controller)
          : this.executeChat(this.chat(id), slotID, controller),
      )
      .catch(() => {})
      .finally(() => {
        this.activities.delete(id);
        this.provisional.delete(id);
        this.wake();
      });
  }
  private async pump() {
    if (this.pumping || this.closed || this.runtime.isBusy?.()) return;
    this.pumping = true;
    try {
      await this.reconcileCompactions();
      await this.activatePending();
      const chat = [...this.chats.values()].find((c) => c.state === "queued");
      let instant: Run | undefined;
      for (const s of this.storage.summaries.values())
        if (
          !s.held &&
          ["queued", "paused"].includes(s.state) &&
          !this.activities.has(s.runID)
        ) {
          const r = await this.run(s.runID);
          if (
            this.runInteractive(r) &&
            r.compaction?.status !== "waiting" &&
            r.compaction?.status !== "failed"
          ) {
            instant = r;
            break;
          }
        }
      if (chat || instant) {
        this.interruptBackground("instant");
        if (this.activities.size) return;
        const modelID = chat?.input.modelID ?? instant!.agent.modelID;
        const slot = executionSlots(this.storage.store.config).find(
          (s) => s.modelID === modelID && s.instant,
        );
        if (slot)
          this.launch(
            chat?.requestID ?? instant!.runID,
            chat ? "chat" : "run",
            slot.slotID,
            modelID,
          );
        return;
      }
      const snapshot = await this.schedulerSnapshot();
      const decision = await policyPlan(snapshot);
      if (this.closed) return;
      const current = await this.schedulerSnapshot();
      try {
        validatePlan(current, decision.plan);
      } catch {
        return;
      }
      this.lastDecision = { at: now(), ...decision };
      if (decision.diagnostic)
        this.logger?.emit("scheduler.hookFailed", { reason: "process" });
      for (const id of decision.plan.pause)
        this.activities.get(id)?.controller.abort("scheduler");
      if (decision.plan.pause.length) return;
      for (const item of decision.plan.start) {
        const r = await this.run(item.runID);
        if (
          !r.held &&
          !this.activities.has(r.runID) &&
          ["queued", "paused"].includes(r.state)
        )
          this.launch(r.runID, "run", item.slotID, r.agent.modelID);
      }
    } finally {
      this.pumping = false;
    }
  }
  private async activatePending() {
    await this.storage.exclusive(async () => {
      for (const runID of [...this.storage.pendingRunIDs]) {
        const summary = this.storage.summaries.get(runID)!;
        if (!terminal(summary.state) || this.activities.has(summary.runID))
          continue;
        const r = await this.run(summary.runID);
        const index = r.pendingInputs.findIndex((p) => !p.cancelled);
        if (index < 0) continue;
        const [pending] = r.pendingInputs.splice(index, 1);
        if (pending!.agent) r.agent = pending!.agent;
        if (pending!.skills) r.skills = pending!.skills;
        if (pending!.tools) r.toolSnapshots = pending!.tools;
        r.interactive =
          pending!.source?.admission !== "timer" &&
          this.instantSlot(r.agent.slotID);
        r.deliveryExpected = false;
        r.segment++;
        r.activeMs = 0;
        r.state = "queued";
        r.pauseReason = null;
        r.error = null;
        r.result = null;
        if (pending!.source) r.triggerHistory.push(pending!.source);
        r.messages.push({
          ...pending!.message,
          role: "user",
          toolCalls: [],
          toolCallID: null,
        });
        this.event(r, "message", { messageID: pending!.message.messageID });
        this.event(r, "queued", {});
        await this.save(r);
      }
    });
  }
  private async dispatchTimers() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const time = Date.now(),
        enabled = this.storage.store.config.scheduler.timersEnabled;
      for (const t of this.storage.store.triggers) {
        if (!t.enabled || t.schedule.type === "manual" || !enabled) {
          this.triggerDue.delete(t.triggerID);
          continue;
        }
        const prior = this.triggerDue.get(t.triggerID);
        if (!prior || prior.revision !== t.revision) {
          const next = nextFireAt(t.schedule, t.anchorAt, time);
          if (next)
            this.triggerDue.set(t.triggerID, {
              revision: t.revision,
              at: Date.parse(next),
            });
          continue;
        }
        if (time < prior.at) continue;
        const next = nextFireAt(t.schedule, t.anchorAt, time);
        if (next)
          this.triggerDue.set(t.triggerID, {
            revision: t.revision,
            at: Date.parse(next),
          });
        else this.triggerDue.delete(t.triggerID);
        if (time - prior.at > 5000) continue;
        const hex = createHash("sha256")
          .update(t.triggerID + ":" + t.revision + ":" + prior.at)
          .digest("hex");
        const occurrenceID =
          hex.slice(0, 8) +
          "-" +
          hex.slice(8, 12) +
          "-4" +
          hex.slice(13, 16) +
          "-a" +
          hex.slice(17, 20) +
          "-" +
          hex.slice(20, 32);
        try {
          await this.fireTrigger(
            t.triggerID,
            occurrenceID,
            undefined,
            false,
            true,
          );
        } catch {
          this.logger?.emit("trigger.dispatchFailed", { reason: "process" });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  private instantSlot(slotID: string | undefined) {
    return executionSlots(this.storage.store.config).some(
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
    return executionSlots(this.storage.store.config).some(
      (s) =>
        s.modelID === c.input.modelID &&
        (s.slotID === c.input.slotID || c.input.slotID === "instant") &&
        s.instant,
    );
  }
  private async executeChat(
    c: Chat,
    slotID: string,
    controller: AbortController,
  ) {
    c.state = "running";
    this.chatEvent(c, "started", {});
    const timeout = setTimeout(
      () => controller.abort("timedOut"),
      Math.max(1, c.deadline - Date.now()),
    );
    try {
      if (c.evalOptions) {
        const input = { ...c.input, slotID, persistContext: false, sampling: c.evalOptions.sampling,
          thinking: [...c.input.messages].reverse().find(m => m.role === "user")?.thinking };
        if (!this.runtime.countTokens) throw Error("context_count_unavailable");
        const tokens = await this.runtime.countTokens(input, controller.signal);
        const slot = executionSlots(this.storage.store.config).find(s => s.slotID === slotID)!;
        if (tokens + input.maxOutputTokens > slot.contextTokens) throw Error("context_full");
        c.result = await this.runtime.generate(input, controller.signal, this.deltas(c.requestID));
        controller.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(c.result)) > 1024 * 1024) throw Error("output_limit");
        c.state = "completed";
        this.chatEvent(c, "completed", c.result);
        return;
      }
      const tool = this.tools.get("load_skills")!;
      const messages = withSkillCatalog(
        structuredClone(c.input.messages),
        c.skills,
      );
      const usage = { inputTokens: 0, outputTokens: 0 };
      for (let turn = 0; turn < 16; turn++) {
        const result = await this.runtime.generate(
          {
            ...c.input,
            slotID,
            messages,
            tools: [
              ...c.input.tools,
              {
                name: tool.toolID,
                description: tool.description,
                parameters: tool.parameters,
              },
            ],
            thinking: [...c.input.messages]
              .reverse()
              .find((m) => m.role === "user")?.thinking,
          },
          controller.signal,
          this.deltas(c.requestID),
        );
        controller.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
          throw Error("output_limit");
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
        const assistant: Message = {
          messageID: randomUUID(),
          role: "assistant",
          content: result.text,
          ...(result.reasoningContent
            ? { reasoningContent: result.reasoningContent }
            : {}),
          attachments: [],
          toolCalls: result.toolCalls,
          toolCallID: null,
        };
        messages.push(assistant);
        c.messages.push(assistant);
        this.chatEvent(c, "message", { message: assistant });
        const skillCalls = result.toolCalls.filter(
          (call) => call.name === "load_skills",
        );
        const clientCalls = result.toolCalls.filter(
          (call) => call.name !== "load_skills",
        );
        if (skillCalls.length && turn === 15)
          throw Error("Skill tool turn limit");
        for (const call of skillCalls) {
          const output = await executeModelTool(
            tool,
            call.arguments,
            controller.signal,
            { home: this.storage.home, skills: c.skills },
          );
          const message: Message = {
            messageID: randomUUID(),
            role: "tool",
            content: JSON.stringify(output),
            attachments: [],
            toolCalls: [],
            toolCallID: call.callID,
          };
          messages.push(message);
          c.messages.push(message);
          this.chatEvent(c, "toolResult", { message });
        }
        if (Buffer.byteLength(JSON.stringify(c.messages)) > 4 * 1024 * 1024)
          throw Error("Skill tool context limit");
        if (!skillCalls.length || clientCalls.length) {
          c.result = { ...result, toolCalls: clientCalls, usage };
          break;
        }
      }
      if (!c.result) throw Error("Inference did not complete");
      c.state = "completed";
      this.chatEvent(c, "completed", c.result);
    } catch (error) {
      c.state = controller.signal.aborted
        ? controller.signal.reason === "timedOut"
          ? "timedOut"
          : "cancelled"
        : "failed";
      const evalCode = c.evalOptions && error instanceof Error
        ? ({ context_full: "context_full", context_count_unavailable: "context_count_unavailable", "Incomplete generation": "output_incomplete", output_limit: "output_limit" } as Record<string, string>)[error.message]
        : undefined;
      c.error = { code: evalCode ?? c.state, message: evalCode ?? "Inference did not complete" };
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
  private atStorageLimit(run: Run) {
    return (
      Buffer.byteLength(JSON.stringify(run)) >=
        run.agent.storageLimitMB * 1024 * 1024 ||
      run.messages.length >= 9000 ||
      run.events.length >= 18000 ||
      run.attempts.length >= 9000 ||
      run.hookReceipts.length >= 980
    );
  }
  private pauseForStorage(run: Run) {
    if (run.pauseReason !== "storage_limit")
      this.event(run, "storageLimit", {
        previousState: run.state,
        limitMB: run.agent.storageLimitMB,
        bytes: Buffer.byteLength(JSON.stringify(run)),
        messages: run.messages.length,
        events: run.events.length,
        attempts: run.attempts.length,
      });
    run.state = "paused";
    run.pauseReason = "storage_limit";
    run.held = true;
    run.error = {
      code: "run_storage_limit",
      message:
        "Run storage limit reached; raise the agent limit before releasing. Exporting does not remove history.",
    };
  }
  private compactionFailure(run: Run, message: string) {
    run.state = "paused";
    run.pauseReason = "context_full";
    run.held = true;
    run.error = { code: "context_full", message: message.slice(0, 2000) };
    if (run.compaction) run.compaction.status = "failed";
    this.event(run, "compactionFailed", { message });
  }
  private retryCompaction(run: Run, message: string) {
    const pending = run.compaction;
    if (
      !pending ||
      pending.handler?.type !== "agent" ||
      pending.retries >= (run.agent.compaction?.maxRetries ?? 1)
    ) {
      this.compactionFailure(run, message);
      return;
    }
    this.event(run, "compactionRetry", {
      message,
      requestID: pending.requestID,
      childRunID: pending.childRunID,
      targetTokens: pending.targetTokens,
      attempt: pending.retries + 1,
    });
    pending.retries++;
    pending.requestID = randomUUID();
    pending.childRunID = pending.requestID;
    pending.targetTokens = Math.max(1, Math.floor(pending.targetTokens / 2));
    pending.summary = null;
    pending.status = "waiting";
    run.state = "paused";
    run.pauseReason = "compaction";
    run.held = false;
    run.error = null;
  }
  private async prepareContext(
    run: Run,
    input: Parameters<Runtime["generate"]>[0],
    capacity: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const model = this.storage.store.config.models.find(
      (m) => m.modelID === run.agent.modelID,
    )!;
    if (model.kind !== "chat") return true;
    if (!this.runtime.countTokens) {
      if (run.agent.compaction || model.compactionThresholdTokens) {
        this.compactionFailure(
          run,
          "Runtime does not support context token counting",
        );
        return false;
      }
      return true;
    }
    const threshold = Math.min(
      run.parentRunID
        ? capacity
        : (model.compactionThresholdTokens ?? capacity),
      capacity - input.maxOutputTokens,
    );
    try {
      signal.throwIfAborted();
      if (threshold <= 0)
        throw Error(
          "Output reservation leaves no room for input; lower maxOutputTokens",
        );
      const baseIDs = new Set(this.runMessages(run).map((m) => m.messageID));
      const executionInstructions = input.messages.filter(
        (m) => !baseIDs.has(m.messageID),
      );
      const preparedMessages = (
        checkpoint: Parameters<typeof contextMessages>[1],
      ) => {
        const rebuilt = this.runMessages(run, checkpoint);
        if (
          rebuilt[0]?.role === "system" &&
          input.messages[0]?.role === "system"
        )
          rebuilt[0] = { ...rebuilt[0], content: input.messages[0].content };
        return [...rebuilt, ...executionInstructions];
      };
      let count = await this.runtime.countTokens(input, signal);
      if (run.parentRunID && count >= threshold) {
        // Annotation/JSON overhead belongs to the child's actual model budget.
        // Compact a complete prefix; leave every unprocessed message in the parent.
        const parent = await this.run(run.parentRunID);
        const pending = parent.compaction;
        if (!pending || pending.childRunID !== run.runID)
          throw Error("Compaction parent no longer owns this child");
        const requestMessage = run.messages.find(m => m.role === "user")!;
        const request = JSON.parse(requestMessage.content) as ReturnType<typeof compactionRequest>;
        let fitted = false;
        for (let end = request.messages.length - 1; end > 0; end--) {
          const next = request.messages[end]!;
          // A new user/assistant starts a complete exchange. Never split tool results.
          if (next.role !== "user" && !(next.role === "assistant" && request.messages[end - 1]?.role === "tool")) continue;
          const prefix = request.messages.slice(0, end);
          const content = JSON.stringify({ ...request, messages: prefix });
          const candidate = { ...input, messages: input.messages.map(m =>
            m.messageID === requestMessage.messageID ? { ...m, content } : m) };
          const tokens = await this.runtime.countTokens(candidate, signal);
          if (tokens >= threshold - 32) continue;
          const coveredThrough = parent.messages.findIndex(m => m.messageID === prefix.at(-1)!.messageID);
          if (coveredThrough <= (parent.compactions.at(-1)?.coveredThrough ?? 0)) continue;
          pending.coveredThrough = coveredThrough;
          requestMessage.content = content;
          input.messages = candidate.messages;
          count = tokens;
          await this.storage.exclusive(async () => {
            this.event(parent, "compactionRequested", { partitioned: true, childRunID: run.runID, coveredThrough, inputTokens: tokens });
            await this.save(parent);
            await this.save(run);
          });
          fitted = true;
          break;
        }
        if (!fitted) throw Error("A complete compaction exchange exceeds the summarizer input budget; reduce tool response size or increase its context capacity");
      }
      if (run.compaction?.status === "ready") {
        const pending = run.compaction;
        const warnings: string[] = [];
        try {
          validateSummaryEvidence(pending.summary ?? "", compactionRequest(run));
        } catch (error) {
          warnings.push(error instanceof Error ? error.message : "Summary evidence discrepancy");
        }
        const checkpoint = {
          checkpointID: pending.requestID,
          at: now(),
          coveredThrough: pending.coveredThrough,
          summary: summarySchema.parse({ summary: pending.summary }).summary,
          inputTokens: pending.inputTokens,
          outputTokens: 0,
          childRunID: pending.childRunID,
        };
        const candidate = {
          ...input,
          messages: preparedMessages(checkpoint),
        };
        const tokens = await this.runtime.countTokens(candidate, signal);
        if (tokens >= count)
          throw Error("Compacted context does not fit or did not reduce input");
        if (run.compactions.length >= 1000)
          throw Error("Compaction checkpoint limit");
        checkpoint.outputTokens = tokens;
        run.compactions.push(checkpoint);
        run.compaction = null;
        run.error = null;
        this.event(run, "compacted", {
          checkpointID: checkpoint.checkpointID,
          warnings,
          coveredThrough: checkpoint.coveredThrough,
          inputTokens: count,
          outputTokens: tokens,
          childRunID: checkpoint.childRunID,
        });
        await this.storage.exclusive(() => this.save(run));
        input.messages = candidate.messages;
        input.contextEpoch = run.compactions.length;
        return tokens < threshold ? true : this.prepareContext(run, input, capacity, signal);
      }
      if (count < threshold) return true;
      if (run.parentRunID)
        throw Error(
          "Compactor input exceeds its model budget; recursive compaction is disabled",
        );
      if (!run.agent.compaction)
        throw Error("Context is full and no compaction handler is configured");
      const coveredThrough = compactionBoundary(run);
      if (coveredThrough < 1)
        throw Error(
          "No complete older turn can be compacted; latest input or tool result is too large",
        );
      if (!run.compaction) {
        // Reserve the retained turn, system/skill instructions and summary wrapper
        // before asking a handler to produce a summary. Leave tokenizer slack.
        const retainedTokens = await this.runtime.countTokens(
          {
            ...input,
            messages: preparedMessages({
              checkpointID: randomUUID(),
              at: now(),
              coveredThrough,
              summary: "",
              inputTokens: count,
              outputTokens: 0,
              childRunID: null,
            }),
          },
          signal,
        );
        const summaryBudget = threshold - retainedTokens - 32;
        if (summaryBudget < 1)
          throw Error(
            "Retained context leaves no room for a summary; latest input or tool result is too large",
          );
        run.compaction = {
          retries: 0,
          requestID: randomUUID(),
          coveredThrough,
          targetTokens: Math.max(
            1,
            Math.min(1024, Math.floor(threshold / 3), summaryBudget),
          ),
          inputTokens: count,
          childRunID: null,
          status: "pending",
          summary: null,
          handler: structuredClone(run.agent.compaction.handler),
        };
        this.event(run, "compactionRequested", {
          requestID: run.compaction.requestID,
          coveredThrough,
          inputTokens: count,
        });
        await this.storage.exclusive(() => this.save(run));
      }
      const pending = run.compaction;
      if (pending.handler?.type === "agent") {
        pending.childRunID = pending.requestID;
        pending.status = "waiting";
        run.state = "paused";
        run.pauseReason = "compaction";
        this.event(run, "paused", {
          reason: "compaction",
          childRunID: pending.childRunID,
        });
        await this.storage.exclusive(() => this.save(run));
        return false;
      }
      if (pending.handler?.type !== "script")
        throw Error("Compaction handler unavailable");
      pending.summary = await executeCompactionScript(
        pending.handler,
        compactionRequest(run),
        signal,
      );
      pending.status = "ready";
      await this.storage.exclusive(() => this.save(run));
      return this.prepareContext(run, input, capacity, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof Error && error.name === "ContextPreparationError") {
        run.state = "paused";
        run.held = true;
        run.pauseReason = "runtime_error";
        run.error = {
          code: "context_preparation_failed",
          message: error.message.slice(0, 2000),
        };
        this.event(run, "paused", { reason: "runtime_error", ...run.error });
        return false;
      }
      this.retryCompaction(
        run,
        error instanceof Error
          ? error.message.slice(0, 1000)
          : "Compaction failed",
      );
      return false;
    }
  }
  private async reconcileCompactions() {
    await this.storage.exclusive(async () => {
      for (const runID of [...this.storage.compactingRunIDs]) {
        if (this.activities.has(runID)) continue;
        const parent = await this.run(runID);
        const pending = parent.compaction;
        if (!pending || pending.status !== "waiting" || !pending.childRunID)
          continue;
        let child = this.storage.summaries.has(pending.childRunID)
          ? await this.run(pending.childRunID)
          : null;
        if (terminal(parent.state)) {
          if (child && !terminal(child.state)) {
            const activity = this.activities.get(child.runID);
            if (activity) activity.controller.abort("cancelled");
            else {
              child.state = "cancelled";
              child.pauseReason = null;
              this.event(child, "cancelled", {});
              await this.save(child);
            }
          }
          continue;
        }
        if (parent.held) continue;
        if (!child) {
          try {
            if (pending.handler?.type !== "agent")
              throw Error("Compactor configuration unavailable");
            const agent = structuredClone(this.agent(pending.handler.agentID));
            if (
              agent.mode !== "single-turn" ||
              agent.agentID === parent.agent.agentID ||
              this.storage.store.config.models.find(
                (m) => m.modelID === agent.modelID,
              )?.kind !== "chat"
            )
              throw Error("Compactor must be another single-turn chat agent");
            agent.contextMode = "fresh";
            agent.compaction = null;
            agent.slotID = "auto";
            // Thinking shares the generation budget with the visible summary.
            // Keep its configured allowance; context admission still checks that
            // the complete input and reserved output fit the model slot.
            if (!agent.thinking)
              agent.maxOutputTokens = Math.min(
                agent.maxOutputTokens,
                pending.targetTokens + 128,
              );
            const content = JSON.stringify(compactionRequest(parent));
            if (content.length > 262144)
              throw Error("Compactor request is too large; compact earlier");
            child = runSchema.parse({
              ...parent,
              runID: pending.childRunID,
              revision: 1,
              createdAt: now(),
              updatedAt: now(),
              reviews: [],
              attempts: [],
              deliveryExpected: false,
              validations: [],
              recovery: null,
              parentRunID: parent.runID,
              compaction: null,
              compactions: [],
              agent,
              skills: [],
              toolSnapshots: [],
              held: false,
              interactive: false,
              pendingInputs: [],
              triggerHistory: [],
              triggerSource: null,
              segment: 0,
              state: "queued",
              pauseReason: null,
              activeMs: 0,
              result: null,
              error: null,
              hookReceipts: [],
              events: [],
              messages: [
                {
                  messageID: randomUUID(),
                  role: "system",
                  content:
                    agent.systemPrompt +
                    "\n" +
                    compactionInstructions +
                    ` Keep the summary under ${Math.max(8, Math.min(180, Math.floor(pending.targetTokens / 3)))} words. Return complete JSON before the output limit.`,
                  attachments: [],
                  toolCalls: [],
                  toolCallID: null,
                },
                {
                  messageID: randomUUID(),
                  role: "user",
                  content,
                  attachments: [],
                  toolCalls: [],
                  toolCallID: null,
                },
              ],
            });
            this.event(child, "message", {
              messageID: child.messages[1]!.messageID,
            });
            this.event(child, "queued", { parentRunID: parent.runID });
            await this.storage.write(child, true);
          } catch (error) {
            this.compactionFailure(
              parent,
              error instanceof Error
                ? error.message
                : "Compactor admission failed",
            );
            await this.save(parent);
          }
          continue;
        }
        if (this.activities.has(child.runID)) continue;
        if (child.state === "completed") {
          try {
            if (
              child.validations.some((v) => v.segment === child.segment) &&
              child.validations
                .filter((v) => v.segment === child.segment)
                .at(-1)?.status !== "passed"
            )
              throw Error("Compactor output validation failed");
            pending.summary = parseCompactionSummary(child.result ?? "");
            pending.status = "ready";
            parent.pauseReason = "compaction";
          } catch {
            this.retryCompaction(
              parent,
              "Compactor did not return a valid summary object",
            );
          }
          await this.save(parent);
        } else if (child.pauseReason === "runtime_error") {
          parent.state = "paused";
          parent.held = true;
          parent.pauseReason = "runtime_error";
          parent.error = {
            code: "context_preparation_failed",
            message: (
              "Compactor runtime: " +
              (child.error?.message ?? "Context preparation failed")
            ).slice(0, 2000),
          };
          this.event(parent, "paused", {
            reason: "runtime_error",
            childRunID: child.runID,
            ...parent.error,
          });
          await this.save(parent);
        } else if (
          terminal(child.state) ||
          child.pauseReason === "context_full"
        ) {
          this.retryCompaction(
            parent,
            "Compactor did not complete: " +
              (child.error?.message ?? child.state),
          );
          await this.save(parent);
        }
      }
    });
  }
  private async executeRun(
    runID: string,
    slotID: string,
    controller: AbortController,
  ) {
    const r = await this.storage.exclusive(async () => {
      const value = await this.run(runID);
      this.liveRuns.set(runID, value);
      return value;
    });
    if (terminal(r.state) || r.held) {
      this.liveRuns.delete(runID);
      return;
    }
    const configuredSlot = executionSlots(this.storage.store.config).find(
      (s) => s.slotID === slotID && s.modelID === r.agent.modelID,
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

    r.state = "running";
    r.pauseReason = null;
    this.event(r, "started", {});
    await this.storage.exclusive(() => this.save(r));
    let activeAttempt: Attempt | undefined;
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
    const slice = setTimeout(
      () => controller.abort("timeSlice"),
      r.agent.timeSliceMs,
    );
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
        if (this.atStorageLimit(r)) {
          this.pauseForStorage(r);
          break;
        }
        // Resume committed tool calls before requesting another model response.
        const currentMessages = r.messages.slice(
          r.messages.map((m) => m.role).lastIndexOf("user") + 1,
        );
        const lastAssistant = [...currentMessages]
          .reverse()
          .find((m) => m.role === "assistant");
        const continuation = this.responseContinuation(r);
        const prefix = continuation.map((a) => a.text).join("");
        const priorReasoning = continuation.map((a) => a.reasoningContent).join("");
        if (lastAssistant)
          for (const call of lastAssistant.toolCalls) {
            if (this.atStorageLimit(r)) break;
            if (r.messages.some((m) => m.toolCallID === call.callID)) continue;
            if (controller.signal.aborted) break;
            const callIndex = currentMessages
              .flatMap((m) => m.toolCalls)
              .findIndex((c) => c.callID === call.callID);
            const output =
              r.agent.maxToolCalls !== undefined &&
              callIndex >= r.agent.maxToolCalls
                ? {
                    ok: false,
                    error: {
                      code: "tool_budget_exhausted",
                      outcome: "not_started",
                      message:
                        "Tool budget exhausted. Return a final answer from the available evidence.",
                    },
                  }
                : await this.invokeTool(
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
        if (this.atStorageLimit(r)) {
          this.pauseForStorage(r);
          break;
        }
        let repairReason: string | null = null;
        if (
          lastAssistant &&
          !continuation.length &&
          !lastAssistant.toolCalls.length &&
          lastAssistant.content.trim()
        ) {
          const validation = r.agent.outputValidation;
          let verdict = r.validations.find(
            (v) => v.messageID === lastAssistant.messageID,
          );
          if (validation && !verdict) {
            verdict = await validateOutput(
              r,
              lastAssistant,
              this.storage.home,
              controller.signal,
            );
            r.validations.push(verdict);
            this.event(r, "outputValidation", {
              messageID: lastAssistant.messageID,
              status: verdict.status,
              reason: verdict.reason,
            });
            await this.storage.exclusive(() => this.save(r));
          }
          const failures = r.validations.filter(
            (v) => v.segment === r.segment && v.status !== "passed",
          ).length;
          if (
            validation &&
            verdict?.status === "failed" &&
            failures <= validation.repairAttempts
          ) {
            repairReason = verdict.reason;
          } else {
            r.state = "completed";
            r.result = lastAssistant.content;
            this.event(r, "completed", { messageID: lastAssistant.messageID });
            break;
          }
        }
        const turnMessages = r.messages.slice(
          r.messages.map((m) => m.role).lastIndexOf("user") + 1,
        );
        const recovery = r.recovery?.segment === r.segment ? r.recovery : null;
        const afterRecovery = recovery
          ? turnMessages.slice(
              turnMessages.findIndex(
                (m) => m.messageID === recovery.afterMessageID,
              ) + 1,
            )
          : turnMessages;
        const problem =
          recovery && !afterRecovery.some((m) => m.role === "tool")
            ? null
            : loopProblem(
                turnMessages,
                recovery
                  ? { ...r.agent.loopPolicy, consecutiveErrors: 1 }
                  : r.agent.loopPolicy,
              );
        if (problem && !repairReason) {
          if (!recovery) {
            r.recovery = {
              segment: r.segment,
              afterMessageID: turnMessages.at(-1)!.messageID,
              reason: problem,
              finalizing: false,
            };
            this.event(r, "loopRecovery", {
              reason: problem,
              finalizing: false,
            });
          } else if (!recovery.finalizing) {
            recovery.finalizing = true;
            this.event(r, "loopRecovery", {
              reason: problem,
              finalizing: true,
            });
          }
          await this.storage.exclusive(() => this.save(r));
        }
        const budgetExhausted =
          r.agent.maxToolCalls !== undefined &&
          currentMessages.reduce((count, m) => count + m.toolCalls.length, 0) >=
            r.agent.maxToolCalls;
        if (
          budgetExhausted &&
          (r.recovery?.segment !== r.segment || !r.recovery.finalizing)
        ) {
          r.recovery = {
            segment: r.segment,
            afterMessageID: turnMessages.at(-1)!.messageID,
            reason:
              "Tool-call budget exhausted before the agent returned a final answer",
            finalizing: true,
          };
          this.event(r, "loopRecovery", {
            reason: r.recovery.reason,
            finalizing: true,
          });
          await this.storage.exclusive(() => this.save(r));
        }
        const emptyAnswer =
          r.agent.mode === "agent-loop" &&
          !!lastAssistant &&
          !lastAssistant.toolCalls.length &&
          !lastAssistant.content.trim();
        const finalizing =
          budgetExhausted ||
          emptyAnswer ||
          !!repairReason ||
          (r.recovery?.segment === r.segment && r.recovery.finalizing);
        const thinking = finalizing || continuation.length > 0
          ? false
          : ([...r.messages].reverse().find((m) => m.role === "user")
              ?.thinking ?? r.agent.thinking);
        const messages = this.runMessages(r);
        if (r.agent.outputValidation?.validator.type === "json-schema") {
          const instruction =
            "Final output must be JSON matching this schema: " +
            JSON.stringify(r.agent.outputValidation.validator.schema);
          const system = messages[0];
          if (system?.role === "system")
            messages[0] = {
              ...system,
              content: system.content + "\n\n" + instruction,
            };
          else
            messages.unshift({
              messageID: randomUUID(),
              role: "system",
              content: instruction,
              attachments: [],
              toolCalls: [],
              toolCallID: null,
            });
        }
        if (
          r.recovery?.segment === r.segment &&
          !r.recovery.finalizing &&
          !finalizing
        )
          messages.push({
            messageID: randomUUID(),
            role: "user",
            content:
              "Nightcrew recovery opportunity: " +
              r.recovery.reason +
              " Do not repeat an unchanged failed request. Correct it or change approach. Another tool failure ends tool use for this turn. Preserve the required final output format.",
            attachments: [],
            toolCalls: [],
            toolCallID: null,
          });
        if (finalizing)
          messages.push({
            messageID: randomUUID(),
            role: "user",
            content:
              (repairReason
                ? "Nightcrew output repair: " +
                  repairReason +
                  ". Correct the previous answer without inventing facts."
                : r.recovery?.finalizing
                  ? "Nightcrew stopped unproductive tool use: " +
                    r.recovery.reason
                  : budgetExhausted
                    ? "Nightcrew execution limit: your tool-call budget for this turn is exhausted."
                    : "Nightcrew finalization: the previous generation contained no visible answer.") +
              " No more tools are available. Return your final answer now using only the original tool evidence already collected. State limitations rather than inventing missing facts. Thinking drafts are not verified evidence. Preserve the configured output format, including JSON when required.",
            attachments: [],
            toolCalls: [],
            toolCallID: null,
          });
        const continueFinalMessage = !!prefix && !continuation.at(-1)?.toolCalls.length;
        if (continueFinalMessage) {
          // Keep the exact prefix inside the open assistant message. A new user
          // turn can make the model omit punctuation at the chunk boundary.
          if (messages.at(-1)?.role === "assistant")
            messages.push({ messageID: randomUUID(), role: "user",
              content: "Complete the unfinished answer in the required format.",
              attachments: [], toolCalls: [], toolCallID: null });
          messages.push({ messageID: randomUUID(), role: "assistant", content: prefix,
            attachments: [], toolCalls: [], toolCallID: null });
        } else if (continuation.length) {
          const partialTools = continuation.at(-1)!.toolCalls;
          messages.push({
            messageID: randomUUID(),
            role: "assistant",
            content: prefix || (priorReasoning
              ? "Unfinished reasoning draft (not verified evidence):\n" + priorReasoning
              : "The previous generation stopped during a tool call."),
            attachments: [], toolCalls: [], toolCallID: null,
          }, {
            messageID: randomUUID(),
            role: "user",
            content: "Nightcrew output continuation: the previous generation reached its per-response token limit. " +
              (partialTools.length
                ? "The unfinished tool calls below were NOT executed. Emit the required complete tool calls again from scratch; never execute partial arguments. Fragments: " + JSON.stringify(partialTools) + ". "
                : prefix
                  ? "Continue the answer EXACTLY where the assistant text ends. Emit only the remaining text, including any needed leading whitespace. Do not repeat, restart, summarize, add a preamble, or wrap JSON in fences. Your text will be appended verbatim to the saved prefix. No more tools are available for this answer. "
                  : "Finish the reasoning and return the answer or complete tool calls. The draft is not a final answer. ") +
              "Preserve the required output format and evidence qualifications.",
            attachments: [], toolCalls: [], toolCallID: null,
          });
        }
        const input: Parameters<Runtime["generate"]>[0] = {
          continueOnOutputLimit: true,
          continueFinalMessage,
          modelID: r.agent.modelID,
          slotID,
          contextID:
            this.storage.store.config.models.find(
              (m) => m.modelID === r.agent.modelID,
            )?.kind === "audio"
              ? undefined
              : r.agent.contextMode === "persistent"
                ? "agent-" +
                  createHash("sha256").update(r.agent.agentID).digest("hex")
                : "run-" + r.runID,
          persistContext: r.agent.contextMode === "persistent",
          contextEpoch: r.compactions.length,
          messages,
          tools: (finalizing || (prefix && !continuation.at(-1)?.toolCalls.length) ? [] : this.runTools(r)).map((t) => ({
            name: t.toolID,
            description: t.description,
            parameters: t.parameters,
          })),
          thinking,
          ...(r.parentRunID && thinking
            ? { reasoningBudgetTokens: Math.min(1024, Math.floor(r.agent.maxOutputTokens / 2)) }
            : {}),
          maxOutputTokens: r.agent.maxOutputTokens,
          temperature: r.agent.temperature,
          sampling: r.agent.sampling,
        };
        if (
          !(await this.prepareContext(
            r,
            input,
            configuredSlot.contextTokens,
            controller.signal,
          ))
        )
          break;
        activeAttempt = {
          attemptID: randomUUID(),
          segment: r.segment,
          startedAt: now(),
          updatedAt: now(),
          status: "running",
          reason: null,
          thinking,
          text: "",
          reasoningContent: "",
          toolCalls: [],
          truncated: false,
          messageID: null,
        };
        r.attempts.push(activeAttempt);
        this.event(r, "attempt", { attemptID: activeAttempt.attemptID });
        await this.storage.exclusive(() => this.save(r));
        const attempt = activeAttempt;
        const delta = this.deltas(runID);
        const result = await this.runtime.generate(
          input,
          controller.signal,
          (text) => {
            attempt.updatedAt = now();
            attempt.text += text;
            if (Buffer.byteLength(attempt.text) > 1048576) {
              attempt.text = Buffer.from(attempt.text)
                .subarray(0, 1048576)
                .toString();
              attempt.truncated = true;
              throw Error("Output limit");
            }
            delta(text);
          },
          (output) => {
            attempt.updatedAt = now();
            if (thinking) {
              attempt.reasoningContent = Buffer.from(output.reasoningContent)
                .subarray(0, 1048576)
                .toString();
              if (Buffer.byteLength(output.reasoningContent) > 1048576)
                attempt.truncated = true;
            }
            attempt.toolCalls = output.toolCalls.slice(0, 32).map((c) => ({
              index: c.index,
              callID: c.callID.slice(0, 128),
              name: c.name.slice(0, 128),
              arguments: c.arguments.slice(0, 64000),
            }));
            if (
              output.toolCalls.some(
                (c) =>
                  c.arguments.length > 64000 ||
                  c.name.length > 128 ||
                  c.callID.length > 128,
              )
            )
              attempt.truncated = true;
          },
        );
        if (controller.signal.aborted) break;
        if (result.outputLimitReached) {
          // These attempts are durable continuation chunks, not complete messages.
          // They survive interruption/restart/compaction without completing the run
          // or executing unfinished tool calls. No new user turn/budget is created.
          attempt.text = result.text;
          attempt.reasoningContent = thinking ? (result.reasoningContent ?? "") : "";
          attempt.status = "interrupted";
          attempt.reason = "output_limit";
          attempt.updatedAt = now();
          activeAttempt = undefined;
          this.provisional.delete(runID);
          await this.storage.exclusive(() => this.save(r));
          if (!attempt.text && !attempt.reasoningContent && !attempt.toolCalls.length)
            throw Error("Output continuation made no progress");
          if (Buffer.byteLength(prefix + attempt.text) > 1048576 ||
              Buffer.byteLength(priorReasoning + attempt.reasoningContent) > 1048576)
            throw Error("Assembled response exceeds storage limit");
          continue;
        }
        const content = prefix + result.text;
        const reasoningContent = priorReasoning + (thinking ? (result.reasoningContent ?? "") : "");
        if (Buffer.byteLength(content) > 1048576 || Buffer.byteLength(reasoningContent) > 1048576)
          throw Error("Assembled response exceeds storage limit");
        const m: Message = {
          messageID: randomUUID(),
          role: "assistant",
          content,
          thinking: thinking || continuation.some((a) => a.thinking),
          ...(reasoningContent
            ? { reasoningContent }
            : {}),
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
        for (const chunk of continuation) chunk.messageID = m.messageID;
        if (activeAttempt) {
          activeAttempt.status = "completed";
          activeAttempt.messageID = m.messageID;
          activeAttempt.updatedAt = now();
          activeAttempt.text = "";
          activeAttempt.reasoningContent = "";
          activeAttempt.toolCalls = [];
          activeAttempt = undefined;
        }
        this.provisional.delete(runID);
        this.event(r, "message", { messageID: m.messageID });
        if (!result.toolCalls.length) {
          if (r.agent.mode === "agent-loop" && !result.text.trim()) {
            if (finalizing)
              throw Error("Model returned no visible final answer");
            await this.storage.exclusive(() => this.save(r));
            continue;
          }
          await this.storage.exclusive(() => this.save(r));
          continue;
        }
        if (finalizing)
          throw Error("Model requested tools during tool-free finalization");
        if (r.agent.mode === "single-turn") throw Error("Unexpected tools");
        await this.storage.exclusive(() => this.save(r));
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        r.state = "failed";
        r.error = {
          code: "execution_failed",
          message:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : "Agent execution failed",
        };
        this.event(r, "failed", {});
      }
    } finally {
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        if (reason === "manual") r.held = true;
        if (reason === "cancelled")
          for (const p of r.pendingInputs) p.cancelled = true;
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
                : reason === "timeSlice"
                  ? "timeSlice"
                  : reason === "manual"
                    ? "manualStop"
                    : reason === "scheduler"
                    ? "scheduler"
                    : "restart"
            : null;
        this.event(r, r.state, {});
      }
      if (activeAttempt) {
        activeAttempt.status =
          r.state === "timedOut"
            ? "timedOut"
            : r.state === "cancelled"
              ? "cancelled"
              : r.state === "paused"
                ? "interrupted"
                : "failed";
        activeAttempt.reason = controller.signal.aborted
          ? String(controller.signal.reason).slice(0, 128)
          : (r.error?.code ?? "execution_failed");
        activeAttempt.updatedAt = now();
      }
      clearInterval(timer);
      clearTimeout(slice);
      await checkpointWork;
      charge();
      if (r.activeMs >= r.agent.timeoutMs && r.state === "completed") {
        r.state = "timedOut";
        r.result = null;
        this.event(r, "timedOut", {});
      }
      const finishedState = terminal(r.state) ? r.state : null;
      if (finishedState)
        r.deliveryExpected = this.storage.store.config.hooks.some(
          (h) => h.event === `run.${finishedState}` && h.purpose === "delivery",
        );
      const storagePaused =
        (!finishedState || finishedState === "completed") &&
        this.atStorageLimit(r);
      if (storagePaused) this.pauseForStorage(r);
      await this.storage.exclusive(async () => {
        await this.save(r);
        if (configuredSlot.instant) await this.recordInteraction();
      });
      this.liveRuns.delete(runID);
      if (finishedState) this.scheduleHooks(r, finishedState);
      if (storagePaused) this.scheduleHooks(r, "storageLimit");
    }
  }
  private async invokeTool(
    r: Run,
    name: string,
    args: string,
    signal: AbortSignal,
  ) {
    const definition =
      this.agentToolIDs(r.agent).includes(name) && this.tools.has(name)
        ? this.runTools(r).find((t) => t.toolID === name)
        : undefined;
    return executeModelTool(definition, args, signal, {
      home: this.storage.home,
      agentID: r.agent.agentID,
      runID: r.runID,
      ...(name === "load_skills" ? { skills: r.skills } : {}),
    });
  }

  private async deliverHooks(
    r: Run,
    selectedEvent?: string,
    retryIndex?: number,
  ) {
    const retry = retryIndex === undefined ? null : r.hookReceipts[retryIndex];
    const retryEvent = retry
      ? r.events.find((e) => e.sequence === retry.eventSequence)
      : null;
    const eventType =
      retryEvent?.type ??
      selectedEvent ??
      (r.pauseReason === "storage_limit" ? "storageLimit" : r.state);
    const eventName = `run.${eventType}`;
    const event =
      retryEvent ?? [...r.events].reverse().find((e) => e.type === eventType);
    if (!event) return;
    for (const hook of this.storage.store.config.hooks.filter(
      (h) =>
        h.event === eventName &&
        (!retry || h.executablePath === retry.executablePath),
    )) {
      const accepted = await this.storage.exclusive(async () => {
        const current = this.liveRuns.get(r.runID) ?? (await this.run(r.runID));
        if (retryIndex !== undefined) {
          const receipt = current.hookReceipts[retryIndex];
          if (!receipt || receipt.status !== "pending") return -1;
        } else if (
          current.hookReceipts.some(
            (h) =>
              h.eventSequence === event.sequence &&
              h.executablePath === hook.executablePath,
          )
        )
          return -1;
        const blocked =
          hook.purpose === "delivery" &&
          r.validations.some((v) => v.segment === event.segment) &&
          r.validations.filter((v) => v.segment === event.segment).at(-1)
            ?.status !== "passed";
        const index = retryIndex ?? current.hookReceipts.length;
        const updated = {
          requestID: retry?.requestID ?? null,
          retryOf: retry?.retryOf ?? null,
          note: retry?.note ?? null,
          eventSequence: event.sequence,
          executablePath: hook.executablePath,
          purpose: hook.purpose,
          status: blocked ? ("failed" as const) : ("started" as const),
          diagnostic: blocked
            ? "Delivery not dispatched: output validation did not pass"
            : null,
        };
        if (retryIndex === undefined) current.hookReceipts.push(updated);
        else current.hookReceipts[index] = updated;
        await this.save(current);
        return blocked ? -1 : index;
      });
      if (accepted < 0) continue;
      const hookResult = await new Promise<{
        ok: boolean;
        diagnostic: string | null;
      }>((resolve) => {
        const child = spawn(hook.executablePath, [], {
          stdio: ["pipe", "ignore", "ignore"],
          env: { PATH: process.env.PATH ?? "" },
          detached: true,
        });
        let finished = false;
        let diagnostic: string | null = null;
        const done = (value: boolean) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({ ok: value, diagnostic: value ? null : diagnostic });
        };
        const timer = setTimeout(() => {
          diagnostic = `Hook timed out after ${hook.timeoutMs} ms`;
          if (child.pid)
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {}
        }, hook.timeoutMs);
        child.once("error", (error) => {
          diagnostic = error.message.slice(0, 2000);
          done(false);
        });
        child.once("exit", (code, signal) => {
          diagnostic ??= `Hook exited with code ${code}, signal ${signal ?? "none"}`;
          done(code === 0);
        });
        child.stdin.on("error", () => {});
        child.stdin.end(
          JSON.stringify({
            version: 1,
            event: eventName,
            runID: r.runID,
            agentID: r.agent.agentID,
            segment: event.segment,
            state: eventType === "storageLimit" ? "paused" : eventType,
            eventSequence: event.sequence,
            ...(eventType === "storageLimit" ? { storage: event.data } : {}),
            result: r.result,
            error: r.error,
          }) + "\n",
        );
      });
      await this.storage.exclusive(async () => {
        const current = this.liveRuns.get(r.runID) ?? (await this.run(r.runID));
        const receipt = current.hookReceipts[accepted]!;
        receipt.status = hookResult.ok ? "succeeded" : "failed";
        receipt.diagnostic = hookResult.diagnostic;
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
    for (const active of this.activities.values())
      active.controller.abort("restart");
    while (this.pumping || this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await this.settling;
    await this.runtime.close();
    await Promise.all(this.hookWork);
    await this.storage.close();
  }
}
