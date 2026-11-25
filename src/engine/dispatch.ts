import { createHash } from "node:crypto";
import type { OperationalLog } from "../server/logging.js";
import type { RunRecords } from "../storage/records.js";
import { Storage } from "../storage/store.js";
import type { Context } from "./context.js";
import { now, terminal, type Run } from "./contracts.js";
import { withoutExecution } from "./execution.js";
import type { Instant } from "./instant.js";
import { fail } from "./protocol.js";
import type { Runner } from "./runner.js";
import type { Runs } from "./runs.js";
import type { Presence, Runtime } from "./runtimeTypes.js";
import {
  executionSlots,
  instantModelID,
  policyPlan,
  validatePlan,
  type SchedulerSnapshot,
} from "./scheduler.js";
import { nextFireAt } from "./triggers.js";

interface Dependencies {
  readonly storage: Storage;
  readonly instant: Pick<
    Instant,
    | "chats"
    | "expireDeadlines"
    | "expire"
    | "unloadingInstant"
    | "executeChat"
    | "chat"
  >;
  readonly runtime: Runtime;
  readonly runner: Pick<Runner, "liveRun" | "executeRun" | "clearProvisional">;
  readonly logger: OperationalLog | undefined;
  readonly samplePresence: () => Promise<Presence>;
  readonly records: Pick<RunRecords, "listRuns" | "run">;
  readonly context: Pick<Context, "reconcileCompactions">;
  readonly runs: Pick<Runs, "activatePending" | "fireTrigger">;
}
export class Dispatch {
  constructor(private readonly ports: Dependencies) {}
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
  status() {
    return {
      presence: this.presence,
      cooldownUntil: this.ports.storage.store.cooldownUntil,
      activeRunID: this.active?.kind === "run" ? this.active.id : null,
      queue: [
        ...Array.from(this.ports.storage.summaries.values())
          .filter((x) => !terminal(x.state))
          .map((x) => ({
            resourceID: x.runID,
            kind: "run",
            state: x.state,
            blockingReason: x.held ? "held" : x.pauseReason,
          })),
        ...Array.from(this.ports.instant.chats.values())
          .filter((x) => !terminal(x.state))
          .map((x) => ({
            resourceID: x.requestID,
            kind: "chat",
            state: x.state,
            blockingReason: null,
          })),
      ],
      models: this.ports.runtime.status(),
      slots: executionSlots(this.ports.storage.store.config).map((s) => ({
        ...s,
        busy: [...this.activities.values()].some((a) => a.slotID === s.slotID),
        conversationID:
          this.active?.kind === "chat"
            ? (this.ports.instant.chats.get(this.active.id)?.input
                .conversationID ?? null)
            : null,
      })),
    };
  }
  private activeSlot() {
    return this.active?.slotID;
  }
  interruptBackground(reason: string) {
    for (const a of this.activities.values())
      if (
        a.kind === "run" &&
        !this.runInteractive(this.ports.runner.liveRun(a.id))
      )
        a.controller.abort(reason);
  }
  runInteractive(run: Run | undefined) {
    return (
      !!run &&
      run.agent.modelID === instantModelID(this.ports.storage.store.config) &&
      (run.interactive ?? this.instantSlot(run.agent.slotID))
    );
  }
  capacity() {
    if (this.status().queue.length >= 100) fail("queue_capacity", 429);
    if (this.ports.storage.unreadable.length)
      fail("run_index_unavailable", 503);
  }
  wake() {
    if (!this.closed)
      void withoutExecution(() => this.pump()).catch(() => {
        this.ports.logger?.emit("scheduler.pumpFailed", { reason: "process" });
      });
  }
  async tick() {
    if (this.closed) return;
    if (
      Date.now() - Date.parse(this.presence.observedAt) >= 5000 ||
      !this.presence.samplingHealthy
    ) {
      const wasHealthy = this.presence.samplingHealthy;
      try {
        this.presence = await this.ports.samplePresence();
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
        this.ports.logger?.emit("presence.unhealthy", { reason: "sampling" });
      else if (!wasHealthy) this.ports.logger?.emit("presence.recovered");
    }
    if (this.presence.state !== "away" || !this.presence.samplingHealthy)
      this.interruptBackground("presence");
    this.ports.instant.expireDeadlines();
    await this.dispatchTimers();
    this.ports.runtime.keepWarm?.(
      Date.parse(this.ports.storage.store.cooldownUntil ?? "") || 0,
    );
    this.ports.instant.expire();
    this.wake();
  }
  async schedulerSnapshot(): Promise<SchedulerSnapshot> {
    const config = this.ports.storage.store.config;
    const blockers: string[] = [];
    if (!this.presence.samplingHealthy || this.presence.state !== "away")
      blockers.push("desktop_present_or_unknown");
    if (Date.parse(this.ports.storage.store.cooldownUntil ?? "") > Date.now())
      blockers.push("interaction_cooldown");
    if (
      [...this.activities.values()].some(
        (a) =>
          a.kind === "chat" ||
          this.runInteractive(this.ports.runner.liveRun(a.id)),
      )
    )
      blockers.push("instant_work");
    if (
      [...this.ports.instant.chats.values()].some((c) => c.state === "queued")
    )
      blockers.push("interactive_queue");
    const pending = [];
    const dependencyIDs = new Set<string>();
    for (const summary of await this.ports.records.listRuns()) {
      if (
        summary.held ||
        this.activities.has(summary.runID) ||
        !["queued", "paused"].includes(summary.state)
      )
        continue;
      const run = await this.ports.records.run(summary.runID);
      if (run.parentRunID) {
        const parent = await this.ports.records.run(run.parentRunID);
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
          this.ports.storage.summaries.has(p.runID) &&
          dependencyIDs.has(p.runID),
      )
        ? pending.filter((p) => dependencyIDs.has(p.runID))
        : pending,
      active: [...this.activities.values()]
        .filter(
          (a) =>
            a.kind === "run" &&
            !this.runInteractive(this.ports.runner.liveRun(a.id)),
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
      instantModelID: instantModelID(this.ports.storage.store.config),
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
    if (this.ports.instant.unloadingInstant) return;
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
          ? this.ports.runner.executeRun(id, slotID, controller)
          : this.ports.instant.executeChat(
              this.ports.instant.chat(id),
              slotID,
              controller,
            ),
      )
      .catch(() => {})
      .finally(() => {
        this.activities.delete(id);
        this.ports.runner.clearProvisional(id);
        this.wake();
      });
  }
  private async pump() {
    if (
      this.pumping ||
      this.closed ||
      this.ports.instant.unloadingInstant ||
      this.ports.runtime.isBusy?.()
    )
      return;
    this.pumping = true;
    try {
      await this.ports.context.reconcileCompactions();
      await this.ports.runs.activatePending();
      const chat = [...this.ports.instant.chats.values()].find(
        (c) => c.state === "queued",
      );
      let instant: Run | undefined;
      for (const s of this.ports.storage.summaries.values())
        if (
          !s.held &&
          ["queued", "paused"].includes(s.state) &&
          !this.activities.has(s.runID)
        ) {
          const r = await this.ports.records.run(s.runID);
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
        const slot = executionSlots(this.ports.storage.store.config).find(
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
        this.ports.logger?.emit("scheduler.hookFailed", { reason: "process" });
      for (const id of decision.plan.pause)
        this.activities.get(id)?.controller.abort("scheduler");
      if (decision.plan.pause.length) return;
      for (const item of decision.plan.start) {
        const r = await this.ports.records.run(item.runID);
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
  private async dispatchTimers() {
    if (this.ticking || this.closed) return;
    this.ticking = true;
    try {
      const time = Date.now(),
        enabled = this.ports.storage.store.config.scheduler.timersEnabled;
      for (const t of this.ports.storage.store.triggers) {
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
          await this.ports.runs.fireTrigger(
            t.triggerID,
            occurrenceID,
            undefined,
            false,
            true,
          );
        } catch {
          this.ports.logger?.emit("trigger.dispatchFailed", {
            reason: "process",
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
  instantSlot(slotID: string | undefined) {
    return executionSlots(this.ports.storage.store.config).some(
      (s) => s.slotID === slotID && s.instant,
    );
  }
  // Caller holds the storage lock so cooldown commits with the interaction.
  async recordInteraction() {
    const next = structuredClone(this.ports.storage.store);
    next.cooldownUntil = new Date(
      Date.now() + next.config.interactionCooldownMs,
    ).toISOString();
    await this.ports.storage.saveConfig(next);
  }
  async start() {
    await this.tick();
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        this.ports.logger?.emit("scheduler.tickFailed", { reason: "process" });
      });
    }, 1000);
    this.timer.unref();
  }
  async stop() {
    this.closed = true;
    clearInterval(this.timer);
    for (const active of this.activities.values())
      active.controller.abort("restart");
    while (this.pumping || this.ticking)
      await new Promise((resolve) => setTimeout(resolve, 10));
    await this.settling;
  }

  hasActivity(id: string) {
    return this.activities.has(id);
  }
  activity(id: string) {
    const a = this.activities.get(id);
    return a
      ? { task: a.task, abort: (reason: string) => a.controller.abort(reason) }
      : undefined;
  }
  activeActivities() {
    return [...this.activities.values()].map(
      ({ id, kind, slotID, modelID }) => ({ id, kind, slotID, modelID }),
    );
  }
  get activityCount() {
    return this.activities.size;
  }
  clearResidentModel() {
    this.residentModelID = null;
  }
}
