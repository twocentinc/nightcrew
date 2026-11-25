import type { RunRecords } from "../storage/records.js";
import { Storage } from "../storage/store.js";
import type { Compaction } from "./compaction.js";
import type { Completion } from "./completion.js";
import type { Context } from "./context.js";
import { terminal, type Run } from "./contracts.js";
import type { Inference, RunExecution } from "./inference.js";
import type { RequestBuilder } from "./request.js";
import type { ResponseRecorder, TurnHistory } from "./response.js";
import { executionSlots } from "./scheduler.js";
import type { ToolExecution } from "./tools.js";

interface Dependencies {
  readonly storage: Storage;
  readonly records: Pick<RunRecords, "run" | "save" | "event">;
  readonly context: Pick<Context, "atStorageLimit" | "pauseForStorage">;
  readonly response: Pick<
    ResponseRecorder,
    "responseContinuation" | "recordOutput"
  >;
  readonly tools: Pick<ToolExecution, "resumeTools">;
  readonly completion: Pick<
    Completion,
    "validateFinal" | "settleInterrupted" | "finishRun"
  >;
  readonly request: Pick<RequestBuilder, "prepareTurn">;
  readonly compaction: Pick<Compaction, "prepareContext">;
  readonly inference: Pick<Inference, "startAttempt" | "generate">;
}
export class Runner {
  constructor(private readonly ports: Dependencies) {}
  private liveRuns = new Map<string, Run>();
  async executeRun(runID: string, slotID: string, controller: AbortController) {
    const r = await this.ports.storage.exclusive(async () => {
      const value = await this.ports.records.run(runID);
      this.liveRuns.set(runID, value);
      return value;
    });
    if (terminal(r.state) || r.held) {
      this.liveRuns.delete(runID);
      return;
    }
    const configuredSlot = executionSlots(this.ports.storage.store.config).find(
      (s) => s.slotID === slotID && s.modelID === r.agent.modelID,
    );
    if (!configuredSlot) {
      r.state = "paused";
      r.pauseReason = "restart";
      r.error = {
        code: "configuration_unavailable",
        message: "Original model and slot configuration is unavailable",
      };
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
      return;
    }

    r.state = "running";
    r.pauseReason = null;
    this.ports.records.event(r, "started", {});
    await this.ports.storage.exclusive(() => this.ports.records.save(r));
    const state: RunExecution = {};
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
          await this.ports.storage.exclusive(() => this.ports.records.save(r));
        })
        .catch(() => controller.abort("storage_failure"));
    }, 1000);
    try {
      while (!controller.signal.aborted) {
        if (this.ports.context.atStorageLimit(r)) {
          this.ports.context.pauseForStorage(r);
          break;
        }
        // Resume committed tool calls before requesting another model response.
        const currentMessages = r.messages.slice(
          r.messages.map((m) => m.role).lastIndexOf("user") + 1,
        );
        const lastAssistant = [...currentMessages]
          .reverse()
          .find((m) => m.role === "assistant");
        const continuation = this.ports.response.responseContinuation(r);
        const prefix = continuation.map((a) => a.text).join("");
        const priorReasoning = continuation
          .map((a) => a.reasoningContent)
          .join("");
        // A finish response is exclusive: never execute siblings in a mixed batch.
        const finishBatch =
          !!r.agent.finishSchema &&
          !!lastAssistant?.toolCalls.some((c) => c.name === "finish");
        await this.ports.tools.resumeTools(
          r,
          currentMessages,
          lastAssistant,
          finishBatch,
          controller,
        );
        if (controller.signal.aborted || terminal(r.state)) break;
        if (
          r.agent.finishSchema &&
          currentMessages.filter(
            (m) =>
              m.role === "assistant" &&
              (!m.toolCalls.length ||
                m.toolCalls.some((c) => c.name === "finish")),
          ).length >= 3 &&
          !continuation.length
        )
          throw Error(
            "Agent did not provide a valid finish result within three completion attempts",
          );
        if (this.ports.context.atStorageLimit(r)) {
          this.ports.context.pauseForStorage(r);
          break;
        }
        const validation = await this.ports.completion.validateFinal(
          r,
          lastAssistant,
          continuation,
          controller,
        );
        if (validation.completed) break;
        const history: TurnHistory = {
          currentMessages,
          lastAssistant,
          continuation,
          prefix,
          priorReasoning,
          finishBatch,
        };
        const prepared = await this.ports.request.prepareTurn(
          r,
          slotID,
          history,
          validation.repairReason,
        );
        const { input, thinking } = prepared;
        if (
          !(await this.ports.compaction.prepareContext(
            r,
            input,
            configuredSlot.contextTokens,
            controller.signal,
          ))
        )
          break;
        const attempt = await this.ports.inference.startAttempt(
          r,
          thinking,
          state,
        );
        const result = await this.ports.inference.generate(
          runID,
          input,
          controller,
          attempt,
          thinking,
        );
        if (controller.signal.aborted) break;
        await this.ports.response.recordOutput(
          r,
          runID,
          result,
          history,
          prepared,
          state,
        );
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
        this.ports.records.event(r, "failed", {});
      }
    } finally {
      this.ports.completion.settleInterrupted(r, controller, state);
      clearInterval(timer);
      clearTimeout(slice);
      await checkpointWork;
      charge();
      await this.ports.completion.finishRun(
        r,
        runID,
        configuredSlot.instant,
        () => this.liveRuns.delete(runID),
      );
    }
  }
  liveRun(id: string) {
    return this.liveRuns.get(id);
  }
}
