import {
  type EvalDefinition,
  type evalRunStateSchema,
} from "../evals/format.js";
import { evaluationAgent, prepareEvaluation } from "../evals/definitions.js";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { triggerSourceSchema } from "../../schemas/agent.js";
import {
  now,
  terminal,
  validateAttachments,
  type UserMessage,
} from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import { canonical } from "../../utils/json.js";
import type { AgentRegistry } from "../capabilities/registry.js";
import type { Configuration } from "../configuration.js";
import type { Context } from "../execution/context.js";
import type { Runner } from "../execution/runner.js";
import type { Hooks } from "../hooks.js";
import type { Instant } from "../instant/requests.js";
import { fail } from "../protocol.js";
import type { Dispatch } from "../scheduling/dispatch.js";
import { RunControls } from "./controls.js";
import { RunTriggers } from "./triggers.js";

export interface Dependencies {
  readonly storage: Storage;
  readonly instant: Pick<Instant, "chats">;
  readonly dispatch: Pick<
    Dispatch,
    | "wake"
    | "capacity"
    | "instantSlot"
    | "runInteractive"
    | "recordInteraction"
    | "interruptBackground"
    | "hasActivity"
    | "activity"
  >;
  readonly records: Pick<RunRecords, "run" | "save" | "event" | "detail">;
  readonly configuration: Pick<Configuration, "agent">;
  readonly runner: Pick<Runner, "liveRun">;
  readonly context: Pick<Context, "atStorageLimit" | "pauseForStorage">;
  readonly hooks: Pick<Hooks, "scheduleHooks">;
  readonly registry: Pick<
    AgentRegistry,
    "skills" | "agentToolIDs" | "tools" | "validateAgent"
  >;
}

export class Runs {
  readonly controls: RunControls;
  readonly triggers: RunTriggers;
  constructor(private readonly ports: Dependencies) {
    const self = this;
    this.controls = new RunControls({ dependencies: this.ports, main: this });
    this.triggers = new RunTriggers({ dependencies: this.ports, main: this });
  }
  checkMessage(message: UserMessage, modelID: string) {
    const model =
      this.ports.storage.store.config.models.find(
        (m) => m.modelID === modelID,
      ) ?? fail("unknown_model");
    try {
      validateAttachments([{ ...message, role: "user" }], model.kind);
    } catch {
      fail("invalid_attachments");
    }
  }
  acceptance(r: Run, replayed: boolean) {
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
    if (reply && this.ports.dispatch.hasActivity(target))
      await this.ports.dispatch.activity(target)!.task;
    const out = await this.ports.storage.exclusive(() =>
      this.submitLocked(target, message, reply, dryRun),
    );
    if (!dryRun) this.ports.dispatch.wake();
    return out;
  }
  async submitLocked(
    target: string,
    message: UserMessage,
    reply: boolean,
    dryRun: boolean,
    source: z.infer<typeof triggerSourceSchema> | null = null,
    retryNote?: string,
    evaluation?: z.infer<typeof evalRunStateSchema>,
  ) {
    await this.ports.storage.reconcile();
    if (this.ports.storage.unreadable.length)
      fail("run_index_unavailable", 503);
    const existing = this.ports.storage.messages.get(message.messageID);
    if (existing) {
      const r = await this.ports.records.run(existing.runID);
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
      [...this.ports.instant.chats.values()].some(
        (c) => c.input.messages.at(-1)?.messageID === message.messageID,
      )
    )
      fail("message_conflict", 409);
    this.ports.dispatch.capacity();
    let previous = reply ? await this.ports.records.run(target) : null;
    if (
      previous?.evaluation &&
      terminal(previous.state) &&
      ["pending", "running"].includes(previous.evaluation.grade.status)
    )
      fail("eval_grading_in_progress", 409);
    let configuredAgent = reply
      ? previous!.agent.contextMode === "persistent" && !previous!.evaluation
        ? this.ports.configuration.agent(previous!.agent.agentID)
        : previous!.agent
      : this.ports.configuration.agent(target);
    if (evaluation) {
      configuredAgent = evaluationAgent(
        configuredAgent,
        evaluation.definition,
        this.ports.storage.store,
      );
      this.ports.registry.validateAgent(configuredAgent);
    }
    if (
      !evaluation &&
      !previous &&
      configuredAgent.contextMode === "persistent"
    ) {
      const persistentID =
        "persistent-" + createHash("sha256").update(target).digest("hex");
      if (this.ports.storage.summaries.has(persistentID))
        previous =
          this.ports.runner.liveRun(persistentID) ??
          (await this.ports.records.run(persistentID));
    }
    const a =
      previous?.agent.contextMode === "persistent"
        ? configuredAgent
        : (previous?.agent ?? configuredAgent);
    if (
      previous &&
      (previous.pauseReason === "storage_limit" ||
        this.ports.context.atStorageLimit(previous))
    ) {
      if (!dryRun && !this.ports.dispatch.hasActivity(previous.runID)) {
        this.ports.context.pauseForStorage(previous);
        await this.ports.records.save(previous);
        this.ports.hooks.scheduleHooks(previous);
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
        skills: a.skillIDs.map((id) =>
          structuredClone(this.ports.registry.skills.get(id)!),
        ),
        tools: this.ports.registry
          .agentToolIDs(a)
          .map((id) =>
            JSON.parse(JSON.stringify(this.ports.registry.tools.get(id))),
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
        this.ports.records.event(previous, "pendingInput", {
          messageID: message.messageID,
        });
        await this.ports.records.save(previous);
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
      previous.state !== "cancelled" &&
      !retryNote
    )
      fail("run_not_completed", 409);
    const cancelledChildID =
      previous?.state === "cancelled" ? previous.compaction?.childRunID : null;
    const r: Run = previous ?? {
      ...(evaluation ? { evaluation } : {}),
      contextUsage: null,
      capabilityRefreshes: [],
      deliveryExpected: false,
      validations: [],
      recovery: null,
      attempts: [],
      compactions: [],
      compaction: null,
      parentRunID: null,
      version: 4,
      held: false,
      interactive:
        !evaluation &&
        source?.admission !== "timer" &&
        this.ports.dispatch.instantSlot(a.slotID),
      pendingInputs: [],
      triggerHistory: [],
      triggerSource: source,
      toolSnapshots: this.ports.registry
        .agentToolIDs(a)
        .map((id) =>
          JSON.parse(JSON.stringify(this.ports.registry.tools.get(id))),
        ),
      runID:
        !evaluation && a.contextMode === "persistent"
          ? "persistent-" + createHash("sha256").update(a.agentID).digest("hex")
          : randomUUID(),
      revision: 1,
      createdAt: now(),
      updatedAt: now(),
      agent: structuredClone(a),
      skills: a.skillIDs.map((s) =>
        structuredClone(
          this.ports.registry.skills.get(s) ?? fail("skill_not_found"),
        ),
      ),
      turnID: message.messageID,
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
      // A new user message continues the conversation, not the cancelled work.
      if (previous.state === "cancelled") {
        r.held = false;
        // A cancelled turn's pending compaction must not block the new turn.
        r.compaction = null;
        // Close unresolved tool calls without replaying potentially mutating work.
        const answered = new Set(r.messages.map((m) => m.toolCallID));
        for (const call of r.messages.flatMap((m) => m.toolCalls)) {
          if (answered.has(call.callID)) continue;
          const messageID = randomUUID();
          r.messages.push({
            messageID,
            role: "tool",
            content: JSON.stringify({
              ok: false,
              error: {
                code: "run_cancelled",
                outcome: "unknown",
                message:
                  "The run was cancelled before a tool result was recorded. Do not assume success or automatically repeat this action.",
              },
            }),
            attachments: [],
            toolCalls: [],
            toolCallID: call.callID,
          });
          answered.add(call.callID);
          this.ports.records.event(r, "toolResult", { messageID });
        }
      }
      r.agent = structuredClone(a);
      r.skills = a.skillIDs.map((id) =>
        structuredClone(this.ports.registry.skills.get(id)!),
      );
      r.toolSnapshots = this.ports.registry
        .agentToolIDs(a)
        .map((id) =>
          JSON.parse(JSON.stringify(this.ports.registry.tools.get(id))),
        );
      r.interactive =
        !r.evaluation &&
        source?.admission !== "timer" &&
        this.ports.dispatch.instantSlot(a.slotID);
      if (source) r.triggerHistory.push(source);
      r.deliveryExpected = false;
      const previousTurnID = r.turnID;
      r.turnID = message.messageID;
      if (retryNote) {
        r.held = false;
        r.compaction = null;
        this.ports.records.event(r, "retried", {
          previousTurnID,
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
    this.ports.records.event(r, "message", { messageID: message.messageID });
    this.ports.records.event(r, "queued", {});
    if (evaluation) {
      r.messages = [
        r.messages[0]!,
        ...evaluation.definition.messages.map((m) => ({
          ...m,
          messageID: randomUUID(),
        })),
      ];
      r.turnID = r.messages.filter((m) => m.role === "user").at(-1)!.messageID;
      r.events = [];
      for (const m of r.messages.slice(1))
        this.ports.records.event(
          r,
          m.role === "tool" ? "toolResult" : "message",
          { messageID: m.messageID },
        );
      this.ports.records.event(r, "queued", {});
      evaluation.initialMessages = r.messages.length;
      for (const m of r.messages.filter((m) => m.role === "user"))
        this.checkMessage(m, a.modelID);
    } else if (r.evaluation) r.evaluation.grade = { status: "pending" };
    if (Buffer.byteLength(JSON.stringify(r)) > 56 * 1024 * 1024)
      fail("run_capacity", 507);
    if (!dryRun) {
      if (
        cancelledChildID &&
        this.ports.storage.summaries.has(cancelledChildID)
      ) {
        const child = await this.ports.records.run(cancelledChildID);
        if (!terminal(child.state)) {
          const activity = this.ports.dispatch.activity(cancelledChildID);
          if (activity) activity.abort("cancelled");
          else {
            child.state = "cancelled";
            child.pauseReason = null;
            this.ports.records.event(child, "cancelled", {});
            await this.ports.records.save(child);
          }
        }
      }
      await this.ports.storage.write(r, !previous);
      if (this.ports.dispatch.runInteractive(r)) {
        await this.ports.dispatch.recordInteraction();
        this.ports.dispatch.interruptBackground("instant");
      }
    }
    return this.acceptance(r, false);
  }
  async submitEval(
    definition: EvalDefinition,
    revision: number,
    dryRun = false,
  ) {
    const evaluation = await prepareEvaluation(definition, revision);
    const result = await this.ports.storage.exclusive(() =>
      this.submitLocked(
        evaluation.definition.agentID,
        { messageID: randomUUID(), content: "", attachments: [] },
        false,
        dryRun,
        null,
        undefined,
        evaluation,
      ),
    );
    if (!dryRun) this.ports.dispatch.wake();
    return result;
  }
  fireTrigger(
    triggerID: string,
    occurrenceID: string,
    replacement: Omit<UserMessage, "messageID"> | undefined,
    dryRun: boolean,
    scheduled = false,
  ) {
    return this.triggers.fireTrigger(
      triggerID,
      occurrenceID,
      replacement,
      dryRun,
      scheduled,
    );
  }
  refreshRunCapabilities(
    runID: string,
    expectedRevision: number,
    dryRun = false,
  ) {
    return this.controls.refreshRunCapabilities(
      runID,
      expectedRevision,
      dryRun,
    );
  }
  retryRun(
    runID: string,
    input: { expectedRevision: number; messageID: string; note: string },
    dryRun: boolean,
  ) {
    return this.controls.retryRun(runID, input, dryRun);
  }
  pauseRun(runID: string, expectedRevision: number, dryRun: boolean) {
    return this.controls.pauseRun(runID, expectedRevision, dryRun);
  }
  queueControl(
    runID: string,
    action: "hold" | "release" | "cancel",
    expectedRevision: number,
    dryRun: boolean,
  ) {
    return this.controls.queueControl(runID, action, expectedRevision, dryRun);
  }
  cancelRun(runID: string, dryRun = false) {
    return this.controls.cancelRun(runID, dryRun);
  }
  activatePending() {
    return this.triggers.activatePending();
  }
}
