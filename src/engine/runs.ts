import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunRecords } from "../storage/records.js";
import { Storage, canonical } from "../storage/store.js";
import type { Configuration } from "./configuration.js";
import type { Context } from "./context.js";
import {
  now,
  terminal,
  triggerSourceSchema,
  validateAttachments,
  type Run,
  type UserMessage,
} from "./contracts.js";
import type { Dispatch } from "./dispatch.js";
import type { Hooks } from "./hooks.js";
import type { Instant } from "./instant.js";
import { fail } from "./protocol.js";
import type { AgentRegistry } from "./registry.js";
import type { Runner } from "./runner.js";
import { reviewFingerprint } from "./supervision.js";

interface Dependencies {
  readonly storage: Storage;
  readonly instant: Pick<Instant, "unloadingInstant" | "chats">;
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
  constructor(private readonly ports: Dependencies) {}
  private checkMessage(message: UserMessage, modelID: string) {
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
    if (this.ports.instant.unloadingInstant)
      fail("instant_unload_in_progress", 409);
    if (reply && this.ports.dispatch.hasActivity(target))
      await this.ports.dispatch.activity(target)!.task;
    const out = await this.ports.storage.exclusive(() =>
      this.submitLocked(target, message, reply, dryRun),
    );
    if (!dryRun) this.ports.dispatch.wake();
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
    if (this.ports.instant.unloadingInstant)
      fail("instant_unload_in_progress", 409);
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
    const configuredAgent = reply
      ? previous!.agent.contextMode === "persistent"
        ? this.ports.configuration.agent(previous!.agent.agentID)
        : previous!.agent
      : this.ports.configuration.agent(target);
    if (!previous && configuredAgent.contextMode === "persistent") {
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
      contextUsage: null,
      capabilityRefreshes: [],
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
      interactive:
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
        a.contextMode === "persistent"
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
      // A new user message continues the conversation, not the cancelled work.
      if (previous.state === "cancelled") {
        r.held = false;
        // A cancelled segment's pending compaction must not block the new turn.
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
        source?.admission !== "timer" &&
        this.ports.dispatch.instantSlot(a.slotID);
      if (source) r.triggerHistory.push(source);
      r.deliveryExpected = false;
      r.segment++;
      if (retryNote) {
        r.held = false;
        r.compaction = null;
        this.ports.records.event(r, "retried", {
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
    this.ports.records.event(r, "message", { messageID: message.messageID });
    this.ports.records.event(r, "queued", {});
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
  async fireTrigger(
    triggerID: string,
    occurrenceID: string,
    replacement: Omit<UserMessage, "messageID"> | undefined,
    dryRun: boolean,
    scheduled = false,
  ) {
    const hash = (input: Omit<UserMessage, "messageID">) =>
      createHash("sha256").update(canonical(input)).digest("hex");
    const outcome = await this.ports.storage.exclusive(async () => {
      await this.ports.storage.reconcile();
      if (this.ports.storage.unreadable.length)
        fail("run_index_unavailable", 503);
      const related: Run[] = [];
      for (const summary of this.ports.storage.summaries.values()) {
        const run = await this.ports.records.run(summary.runID);
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
      if (this.ports.storage.messages.has(occurrenceID))
        fail("message_conflict", 409);
      const trigger =
        this.ports.storage.store.triggers.find(
          (t) => t.triggerID === triggerID,
        ) ?? fail("trigger_not_found", 404);
      if (!trigger.enabled) fail("trigger_disabled", 409);
      const agent = this.ports.configuration.agent(trigger.agentID);
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
          const run = this.ports.runner.liveRun(candidate.runID) ?? candidate;
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
              this.ports.records.event(run, "pendingInput", {
                messageID: occurrenceID,
              });
              this.ports.records.event(run, "coalesced", {
                messageID: occurrenceID,
              });
              await this.ports.records.save(run);
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
                !this.ports.dispatch.hasActivity(r.runID) &&
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
        this.ports.records.event(pending, "message", {
          messageID: occurrenceID,
        });
        this.ports.records.event(pending, "coalesced", {
          messageID: occurrenceID,
        });
        if (Buffer.byteLength(JSON.stringify(pending)) > 56 * 1024 * 1024)
          fail("run_capacity", 507);
        if (!dryRun) await this.ports.records.save(pending);
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
    if (!dryRun && outcome.changed) this.ports.dispatch.wake();
    return outcome;
  }
  async refreshRunCapabilities(
    runID: string,
    expectedRevision: number,
    dryRun = false,
  ) {
    return this.ports.storage.exclusive(async () => {
      const run = await this.ports.records.run(runID);
      if (run.revision !== expectedRevision) fail("revision_conflict", 409);
      if (
        !terminal(run.state) ||
        this.ports.dispatch.hasActivity(runID) ||
        run.pendingInputs.some((p) => !p.cancelled)
      )
        fail("run_not_idle", 409);
      const configured = this.ports.configuration.agent(run.agent.agentID);
      const candidate = {
        ...run.agent,
        toolIDs: [...configured.toolIDs],
        skillIDs: [...configured.skillIDs],
      };
      this.ports.registry.validateAgent(candidate);
      const skills = candidate.skillIDs.map((id) =>
        structuredClone(this.ports.registry.skills.get(id)!),
      );
      const tools = this.ports.registry
        .agentToolIDs(candidate)
        .map((id) =>
          JSON.parse(JSON.stringify(this.ports.registry.tools.get(id))),
        );
      const changed =
        canonical({
          toolIDs: run.agent.toolIDs,
          skillIDs: run.agent.skillIDs,
          skills: run.skills,
          tools: run.toolSnapshots,
        }) !==
        canonical({
          toolIDs: candidate.toolIDs,
          skillIDs: candidate.skillIDs,
          skills,
          tools,
        });
      if (changed && !dryRun) {
        if (run.capabilityRefreshes.length >= 100)
          fail("capability_refresh_limit", 409);
        run.capabilityRefreshes.push({
          at: now(),
          segment: run.segment,
          sourceAgentRevision: configured.revision,
          previousToolIDs: run.agent.toolIDs,
          previousSkillIDs: run.agent.skillIDs,
          previousTools: run.toolSnapshots,
          previousSkills: run.skills,
        });
        run.agent = candidate;
        run.skills = skills;
        run.toolSnapshots = tools;
        run.contextUsage = null;
        if (this.ports.context.atStorageLimit(run)) fail("run_capacity", 507);
        await this.ports.records.save(run);
      }
      return {
        runID,
        revision: run.revision,
        changed: changed && !dryRun,
        toolIDs: candidate.toolIDs,
        skillIDs: candidate.skillIDs,
      };
    });
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
    return this.ports.storage.exclusive(async () => {
      const run = await this.ports.records.run(runID);
      if (run.revision !== input.expectedRevision)
        fail("revision_conflict", 409);
      if (this.ports.dispatch.hasActivity(runID)) fail("run_active", 409);
      if (run.reviews.length >= 1000) fail("review_capacity", 409);
      if (!dryRun) {
        run.reviews.push({
          segment: run.segment,
          status: input.status,
          note: input.note,
          at: now(),
          fingerprint: reviewFingerprint(run),
        });
        this.ports.records.event(run, "reviewed", {
          status: input.status,
          note: input.note,
        });
        await this.ports.records.save(run);
      }
      return { run: this.ports.records.detail(run), changed: !dryRun };
    });
  }
  async retryRun(
    runID: string,
    input: { expectedRevision: number; messageID: string; note: string },
    dryRun: boolean,
  ) {
    const result = await this.ports.storage.exclusive(async () => {
      const run = await this.ports.records.run(runID);
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
      if (!terminal(run.state) || this.ports.dispatch.hasActivity(runID))
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
    if (!dryRun) this.ports.dispatch.wake();
    return result;
  }
  async pauseRun(runID: string, expectedRevision: number, dryRun: boolean) {
    const run = await this.ports.records.run(runID);
    if (run.revision !== expectedRevision) fail("revision_conflict", 409);
    if (terminal(run.state)) fail("run_not_pending", 409);
    const activity = this.ports.dispatch.activity(runID);
    if (activity) {
      if (dryRun)
        return { run: this.ports.records.detail(run), changed: false };
      // Set the live hold before aborting so the scheduler cannot restart it.
      const live = this.ports.runner.liveRun(runID);
      if (live) live.held = true;
      activity.abort("manual");
      await activity.task;
      return {
        run: this.ports.records.detail(await this.ports.records.run(runID)),
        changed: true,
      };
    }
    return this.queueControl(runID, "hold", expectedRevision, dryRun);
  }
  async queueControl(
    runID: string,
    action: "hold" | "release" | "cancel",
    expectedRevision: number,
    dryRun: boolean,
  ) {
    const result = await this.ports.storage.exclusive(async () => {
      const run = await this.ports.records.run(runID);
      if (run.revision !== expectedRevision) fail("revision_conflict", 409);
      if (
        this.ports.dispatch.hasActivity(runID) ||
        (run.state !== "queued" && run.state !== "paused")
      )
        fail("run_not_pending", 409);
      const changed = action === "cancel" || run.held !== (action === "hold");
      if (changed && !dryRun) {
        if (action === "cancel") {
          run.state = "cancelled";
          for (const p of run.pendingInputs) p.cancelled = true;
          run.pauseReason = null;
          this.ports.records.event(run, "cancelled", {});
        } else {
          if (action === "release" && run.pauseReason === "storage_limit") {
            const updated = {
              ...run,
              agent: {
                ...run.agent,
                storageLimitMB: this.ports.configuration.agent(
                  run.agent.agentID,
                ).storageLimitMB,
              },
            };
            if (this.ports.context.atStorageLimit(updated))
              fail("run_storage_limit", 409);
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
              this.ports.configuration.agent(run.agent.agentID).compaction,
            );
            run.error = null;
            run.pauseReason = null;
          }
          if (action === "release" && run.pauseReason === "runtime_error") {
            if (run.compaction?.childRunID) {
              const child = await this.ports.records.run(
                run.compaction.childRunID,
              );
              if (child.pauseReason === "runtime_error") {
                child.held = false;
                child.pauseReason = null;
                child.error = null;
                this.ports.records.event(child, "released", {
                  parentRunID: run.runID,
                });
                await this.ports.records.save(child);
              }
            }
            run.error = null;
            run.pauseReason = null;
          }
          this.ports.records.event(run, run.held ? "held" : "released", {});
        }
        await this.ports.records.save(run);
      }
      return {
        run: this.ports.records.detail(run),
        changed: changed && !dryRun,
      };
    });
    if (result.changed && action === "cancel")
      this.ports.hooks.scheduleHooks(await this.ports.records.run(runID));
    if (result.changed) this.ports.dispatch.wake();
    return result;
  }
  async annotateRun(
    runID: string,
    input: { messageID: string; content: string },
    dryRun = false,
  ) {
    return this.ports.storage.exclusive(async () => {
      const run =
        this.ports.runner.liveRun(runID) ??
        (await this.ports.records.run(runID));
      const existing = run.events.find(
        (e) =>
          e.type === "notification" &&
          (e.data as { messageID?: string }).messageID === input.messageID,
      );
      if (existing) {
        if ((existing.data as { content?: string }).content !== input.content)
          fail("message_conflict", 409);
        return {
          messageID: input.messageID,
          revision: run.revision,
          replayed: true,
        };
      }
      if (this.ports.context.atStorageLimit(run))
        fail("run_storage_limit", 409);
      if (!dryRun) {
        // An event, never a model message or scheduler input. No hooks or wake.
        this.ports.records.event(run, "notification", input);
        await this.ports.records.save(run);
      }
      return {
        messageID: input.messageID,
        revision: run.revision,
        replayed: false,
      };
    });
  }
  async cancelRun(runID: string, dryRun = false) {
    const r = await this.ports.records.run(runID);
    if (terminal(r.state) || dryRun)
      return { runID, status: r.state, changed: false };
    if (this.ports.dispatch.hasActivity(runID)) {
      this.ports.dispatch.activity(runID)!.abort("cancelled");
      await this.ports.dispatch.activity(runID)!.task;
      return {
        runID,
        status: (await this.ports.records.run(runID)).state,
        changed: true,
      };
    }
    const outcome = await this.ports.storage.exclusive(async () => {
      const current = await this.ports.records.run(runID);
      if (terminal(current.state))
        return { runID, status: current.state, changed: false };
      current.state = "cancelled";
      for (const p of current.pendingInputs) p.cancelled = true;
      current.pauseReason = null;
      this.ports.records.event(current, "cancelled", {});
      await this.ports.records.save(current);
      return { runID, status: current.state, changed: true };
    });
    if (outcome.changed) {
      this.ports.hooks.scheduleHooks(await this.ports.records.run(runID));
      this.ports.dispatch.wake();
    }
    return outcome;
  }
  async activatePending() {
    await this.ports.storage.exclusive(async () => {
      if (this.ports.instant.unloadingInstant) return;
      for (const runID of [...this.ports.storage.pendingRunIDs]) {
        const summary = this.ports.storage.summaries.get(runID)!;
        if (
          !terminal(summary.state) ||
          this.ports.dispatch.hasActivity(summary.runID)
        )
          continue;
        const r = await this.ports.records.run(summary.runID);
        const index = r.pendingInputs.findIndex((p) => !p.cancelled);
        if (index < 0) continue;
        const [pending] = r.pendingInputs.splice(index, 1);
        if (pending!.agent) r.agent = pending!.agent;
        if (pending!.skills) r.skills = pending!.skills;
        if (pending!.tools) r.toolSnapshots = pending!.tools;
        r.interactive =
          pending!.source?.admission !== "timer" &&
          this.ports.dispatch.instantSlot(r.agent.slotID);
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
        this.ports.records.event(r, "message", {
          messageID: pending!.message.messageID,
        });
        this.ports.records.event(r, "queued", {});
        await this.ports.records.save(r);
      }
    });
  }
}
