import { randomUUID } from "node:crypto";
import { type Agent, type Skill } from "../../schemas/agent.js";
import {
  now,
  terminal,
  validateAttachments,
  type ChatInput,
  type Message,
} from "../../schemas/common.js";
import { type Event } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import { canonical } from "../../utils/json.js";
import type { AgentRegistry } from "../capabilities/registry.js";
import type { Inference } from "../execution/inference.js";
import type { Runner } from "../execution/runner.js";
import type { Result, Runtime } from "../models/types.js";
import { fail } from "../protocol.js";
import type { Runs } from "../runs/submissions.js";
import type { Dispatch } from "../scheduling/dispatch.js";
import { executionSlots, instantModelID } from "../scheduling/policy.js";
import { InstantRunner } from "./runner.js";

export type Chat = {
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
export interface Dependencies {
  readonly inference: Pick<Inference, "deltas">;
  readonly storage: Storage;
  readonly registry: Pick<AgentRegistry, "skills" | "tools">;
  readonly dispatch: Pick<
    Dispatch,
    | "capacity"
    | "interruptBackground"
    | "wake"
    | "runInteractive"
    | "recordInteraction"
    | "hasActivity"
    | "activity"
    | "activeActivities"
    | "activityCount"
    | "clearResidentModel"
  >;
  readonly runner: Pick<Runner, "liveRun">;
  readonly records: Pick<RunRecords, "run">;
  readonly runtime: Runtime;
  readonly runs: Pick<Runs, "cancelRun">;
}

export class Instant {
  readonly execution: InstantRunner;
  constructor(private readonly ports: Dependencies) {
    const self = this;
    this.execution = new InstantRunner({
      dependencies: this.ports,
      main: this,
    });
  }
  readonly chats = new Map<string, Chat>();
  private unloading = false;
  get unloadingInstant() {
    return this.unloading;
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
  chatEvent(c: Chat, type: Event["type"], data: Event["data"]) {
    c.updatedAt = now();
    c.events.push({
      sequence: c.events.length + 1,
      at: now(),
      type,
      segment: 0,
      data,
    });
  }
  expire() {
    for (const [id, c] of this.chats)
      if (terminal(c.state) && c.expires < Date.now()) this.chats.delete(id);
  }
  async submitChat(
    request: ChatInput,
    evalOptions?: { sampling?: Agent["sampling"] },
  ) {
    if (this.unloading) fail("instant_unload_in_progress", 409);
    const out = await this.ports.storage.exclusive(async () => {
      if (this.unloading) fail("instant_unload_in_progress", 409);
      await this.ports.storage.reconcile();
      this.expire();
      const modelID =
        instantModelID(this.ports.storage.store.config) ??
        fail("instant_model_not_configured");
      if (request.modelID !== undefined && request.modelID !== modelID)
        fail("invalid_instant_model");
      const input = { ...request, skillIDs: request.skillIDs ?? [], modelID };
      if (new Set(input.skillIDs).size !== input.skillIDs.length)
        fail("duplicate_identity");
      if (!evalOptions && input.tools.some((t) => t.name === "load_skills"))
        fail("reserved_tool_name");
      const selectedSkills = (evalOptions ? [] : input.skillIDs).map((id) =>
        structuredClone(
          this.ports.registry.skills.get(id) ?? fail("skill_not_found", 404),
        ),
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
      if (this.ports.storage.messages.has(latest.messageID))
        fail("message_conflict", 409);
      const old = [...this.chats.values()].find(
        (c) => c.input.messages.at(-1)?.messageID === latest.messageID,
      );
      if (old) {
        if (
          canonical(old.input) !== canonical(input) ||
          canonical(old.evalOptions ?? null) !== canonical(evalOptions ?? null)
        )
          fail("message_conflict", 409);
        return {
          requestID: old.requestID,
          status: old.state,
          eventsURL: `/v1/chat/requests/${old.requestID}/events`,
          replayed: true,
        };
      }
      const slot =
        executionSlots(this.ports.storage.store.config).find(
          (s) =>
            (s.slotID === input.slotID ||
              (input.slotID === "instant" && s.instant)) &&
            s.instant &&
            s.modelID === input.modelID,
        ) ?? fail("invalid_slot");
      if (
        this.ports.storage.store.config.models.find(
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
      this.ports.dispatch.capacity();
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
        const next = structuredClone(this.ports.storage.store);
        next.cooldownUntil = new Date(
          Date.now() + next.config.interactionCooldownMs,
        ).toISOString();
        await this.ports.storage.saveConfig(next);
      }
      this.chats.set(c.requestID, c);
      if (slot.instant) this.ports.dispatch.interruptBackground("instant");
      return {
        requestID: c.requestID,
        status: c.state,
        eventsURL: `/v1/chat/requests/${c.requestID}/events`,
        replayed: false,
      };
    });
    this.ports.dispatch.wake();
    return out;
  }
  async unloadInstant(dryRun = false) {
    if (this.unloading) fail("instant_unload_in_progress", 409);
    this.unloading = true;
    try {
      await this.ports.storage.exclusive(async () => {});
      const modelID =
        instantModelID(this.ports.storage.store.config) ??
        fail("instant_model_not_configured");
      // Admission and launch are gated while cancellation settles. Never hold
      // the storage lock while awaiting activities that must persist their end.
      if (
        [...this.ports.dispatch.activeActivities()].some(
          (a) =>
            a.modelID === modelID &&
            a.kind !== "chat" &&
            !this.ports.dispatch.runInteractive(
              this.ports.runner.liveRun(a.id),
            ),
        )
      )
        fail("instant_model_busy_with_background_work", 409);
      const runIDs: string[] = [];
      for (const summary of this.ports.storage.summaries.values()) {
        if (summary.agentID && !terminal(summary.state)) {
          const run = await this.ports.records.run(summary.runID);
          if (
            run.agent.modelID === modelID &&
            this.ports.dispatch.runInteractive(run)
          )
            runIDs.push(run.runID);
        }
      }
      const requestIDs = [...this.chats.values()]
        .filter((c) => c.input.modelID === modelID && !terminal(c.state))
        .map((c) => c.requestID);
      const resident = this.ports.runtime
        .status()
        .some((m) => m.modelID === modelID && m.state !== "unloaded");
      if (dryRun)
        return {
          modelID,
          changed: false,
          cancelledRunIDs: [],
          cancelledRequestIDs: [],
        };
      for (const id of runIDs) await this.ports.runs.cancelRun(id);
      for (const id of requestIDs) await this.cancelChat(id);
      // Runtime owns one resident model. Never close a different resident model.
      if (resident) {
        if (this.ports.dispatch.activityCount || this.ports.runtime.isBusy?.())
          fail("runtime_busy", 409);
        await this.ports.runtime.close();
        this.ports.dispatch.clearResidentModel();
      }
      return {
        modelID,
        changed: resident || !!runIDs.length || !!requestIDs.length,
        cancelledRunIDs: runIDs,
        cancelledRequestIDs: requestIDs,
      };
    } finally {
      this.unloading = false;
    }
  }
  async cancelChat(requestID: string, dryRun = false) {
    const c = this.chat(requestID);
    if (terminal(c.state) || dryRun)
      return { requestID, status: c.state, changed: false };
    if (this.ports.dispatch.hasActivity(requestID)) {
      this.ports.dispatch.activity(requestID)!.abort("cancelled");
      await this.ports.dispatch.activity(requestID)!.task;
    } else {
      c.state = "cancelled";
      c.expires = Date.now() + 900000;
      this.chatEvent(c, "cancelled", {});
    }
    return { requestID, status: c.state, changed: true };
  }
  expireDeadlines() {
    for (const c of this.chats.values())
      if (!terminal(c.state) && c.deadline <= Date.now()) {
        const active = this.ports.dispatch.activity(c.requestID);
        if (active) active.abort("timedOut");
        else {
          c.state = "timedOut";
          c.expires = Date.now() + 900000;
          this.chatEvent(c, "timedOut", {});
        }
      }
  }
  executeChat(c: Chat, slotID: string, controller: AbortController) {
    return this.execution.executeChat(c, slotID, controller);
  }
}
