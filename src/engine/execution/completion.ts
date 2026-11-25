import { now, terminal, type Message } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import type { Hooks } from "../hooks.js";
import type { Attempt } from "../models/types.js";
import type { Dispatch } from "../scheduling/dispatch.js";
import { validateOutput } from "../supervision.js";
import type { Context } from "./context.js";
import type { RunExecution } from "./inference.js";

interface Dependencies {
  readonly storage: Storage;
  readonly records: Pick<RunRecords, "event" | "save">;
  readonly context: Pick<Context, "atStorageLimit" | "pauseForStorage">;
  readonly dispatch: Pick<Dispatch, "recordInteraction">;
  readonly hooks: Pick<Hooks, "scheduleHooks">;
}
export class Completion {
  constructor(private readonly ports: Dependencies) {}
  async validateFinal(
    r: Run,
    lastAssistant: Message | undefined,
    continuation: Attempt[],
    controller: AbortController,
  ) {
    let repairReason: string | null = null;
    if (
      !r.agent.finishSchema &&
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
          this.ports.storage.home,
          controller.signal,
        );
        r.validations.push(verdict);
        this.ports.records.event(r, "outputValidation", {
          messageID: lastAssistant.messageID,
          status: verdict.status,
          reason: verdict.reason,
        });
        await this.ports.storage.exclusive(() => this.ports.records.save(r));
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
        this.ports.records.event(r, "completed", {
          messageID: lastAssistant.messageID,
        });
        return { completed: true, repairReason };
      }
    }
    return { completed: false, repairReason };
  }
  settleInterrupted(r: Run, controller: AbortController, state: RunExecution) {
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
      this.ports.records.event(r, r.state, {});
    }
    if (state.attempt) {
      state.attempt.status =
        r.state === "timedOut"
          ? "timedOut"
          : r.state === "cancelled"
            ? "cancelled"
            : r.state === "paused"
              ? "interrupted"
              : "failed";
      state.attempt.reason = controller.signal.aborted
        ? String(controller.signal.reason).slice(0, 128)
        : (r.error?.code ?? "execution_failed");
      state.attempt.updatedAt = now();
    }
  }
  async finishRun(
    r: Run,
    runID: string,
    instant: boolean,
    release: () => void,
  ) {
    if (r.activeMs >= r.agent.timeoutMs && r.state === "completed") {
      r.state = "timedOut";
      r.result = null;
      this.ports.records.event(r, "timedOut", {});
    }
    const finishedState = terminal(r.state) ? r.state : null;
    if (finishedState)
      r.deliveryExpected = this.ports.storage.store.config.hooks.some(
        (h) => h.event === `run.${finishedState}` && h.purpose === "delivery",
      );
    const storagePaused =
      (!finishedState || finishedState === "completed") &&
      this.ports.context.atStorageLimit(r);
    if (storagePaused) this.ports.context.pauseForStorage(r);
    await this.ports.storage.exclusive(async () => {
      await this.ports.records.save(r);
      if (instant) await this.ports.dispatch.recordInteraction();
    });
    release();
    if (finishedState) this.ports.hooks.scheduleHooks(r, finishedState);
    if (storagePaused) this.ports.hooks.scheduleHooks(r, "storageLimit");
  }
}
