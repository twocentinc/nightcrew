import { randomUUID } from "node:crypto";
import { now } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import type { Configuration } from "../configuration.js";
import { contextMessages, type Context } from "../execution/context.js";
import type { Runtime } from "../models/types.js";
import type { Dispatch } from "../scheduling/dispatch.js";
import { sourceEvidence, validateSummaryEvidence } from "./evidence.js";
import {
  compactionBoundary,
  compactionRequest,
  executeCompactionScript,
  summarySchema,
} from "./format.js";
import { CompactionRecovery } from "./recovery.js";

export interface Dependencies {
  readonly context: Pick<Context, "runMessages">;
  readonly records: Pick<RunRecords, "event" | "run" | "save">;
  readonly storage: Storage;
  readonly runtime: Runtime;
  readonly dispatch: Pick<
    Dispatch,
    "runInteractive" | "hasActivity" | "activity"
  >;
  readonly configuration: Pick<Configuration, "agent">;
}

export class Compaction {
  readonly toolLoop: CompactionRecovery;
  constructor(private readonly ports: Dependencies) {
    const self = this;
    this.toolLoop = new CompactionRecovery({ dependencies: this.ports });
  }
  async prepareContext(
    run: Run,
    input: Parameters<Runtime["generate"]>[0],
    capacity: number,
    signal: AbortSignal,
  ): Promise<boolean> {
    const model = this.ports.storage.store.config.models.find(
      (m) => m.modelID === run.agent.modelID,
    )!;
    if (model.kind !== "chat") return true;
    if (!this.ports.runtime.countTokens) {
      if (run.agent.compaction || model.compactionThresholdTokens) {
        this.toolLoop.compactionFailure(
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
      const baseIDs = new Set(
        this.ports.context.runMessages(run).map((m) => m.messageID),
      );
      const executionInstructions = input.messages.filter(
        (m) => !baseIDs.has(m.messageID),
      );
      const preparedMessages = (
        checkpoint: Parameters<typeof contextMessages>[1],
      ) => {
        const rebuilt = this.ports.context.runMessages(run, checkpoint);
        if (
          rebuilt[0]?.role === "system" &&
          input.messages[0]?.role === "system"
        )
          rebuilt[0] = { ...rebuilt[0], content: input.messages[0].content };
        return [...rebuilt, ...executionInstructions];
      };
      const recordCount = (tokens: number) => {
        run.contextUsage = {
          inputTokens: tokens,
          outputTokens: 0,
          capacityTokens: capacity,
          measuredAt: now(),
          turnID: run.turnID,
        };
      };
      let count = await this.ports.runtime.countTokens(input, signal);
      recordCount(count);
      if (run.parentRunID && count >= threshold) {
        // Annotation/JSON overhead belongs to the child's actual model budget.
        // Compact a complete prefix; leave every unprocessed message in the parent.
        const parent = await this.ports.records.run(run.parentRunID);
        const pending = parent.compaction;
        if (!pending || pending.childRunID !== run.runID)
          throw Error("Compaction parent no longer owns this child");
        const requestMessage = run.messages.find((m) => m.role === "user")!;
        const request = JSON.parse(requestMessage.content) as ReturnType<
          typeof compactionRequest
        >;
        let fitted = false;
        for (let end = request.messages.length - 1; end > 0; end--) {
          const next = request.messages[end]!;
          // A new user/assistant starts a complete exchange. Never split tool results.
          if (
            next.role !== "user" &&
            !(
              next.role === "assistant" &&
              request.messages[end - 1]?.role === "tool"
            )
          )
            continue;
          const prefix = request.messages.slice(0, end);
          const content = JSON.stringify({ ...request, messages: prefix });
          const candidate = {
            ...input,
            messages: input.messages.map((m) =>
              m.messageID === requestMessage.messageID ? { ...m, content } : m,
            ),
          };
          const tokens = await this.ports.runtime.countTokens(
            candidate,
            signal,
          );
          if (tokens >= threshold - 32) continue;
          const coveredThrough = parent.messages.findIndex(
            (m) => m.messageID === prefix.at(-1)!.messageID,
          );
          if (
            coveredThrough <= (parent.compactions.at(-1)?.coveredThrough ?? 0)
          )
            continue;
          pending.coveredThrough = coveredThrough;
          requestMessage.content = content;
          input.messages = candidate.messages;
          count = tokens;
          recordCount(tokens);
          await this.ports.storage.exclusive(async () => {
            this.ports.records.event(parent, "compactionRequested", {
              partitioned: true,
              childRunID: run.runID,
              coveredThrough,
              inputTokens: tokens,
            });
            await this.ports.records.save(parent);
            await this.ports.records.save(run);
          });
          fitted = true;
          break;
        }
        if (!fitted)
          throw Error(
            "A complete compaction exchange exceeds the summarizer input budget; reduce tool response size or increase its context capacity",
          );
      }
      if (run.compaction?.status === "ready") {
        const pending = run.compaction;
        const warnings: string[] = [];
        try {
          validateSummaryEvidence(
            pending.summary ?? "",
            compactionRequest(run),
          );
        } catch (error) {
          warnings.push(
            error instanceof Error
              ? error.message
              : "Summary evidence discrepancy",
          );
        }
        if (pending.structuredSummary) {
          const known = sourceEvidence(
            run.messages.slice(0, pending.coveredThrough + 1),
          ).sources;
          for (const bullets of Object.values(pending.structuredSummary))
            for (const bullet of bullets)
              for (const ref of bullet.sources)
                if (!known.has(ref))
                  throw Error(
                    "Unknown structured summary source reference: " + ref,
                  );
        }
        const checkpoint = {
          ...(pending.structuredSummary
            ? { structuredSummary: pending.structuredSummary }
            : {}),
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
        const tokens = await this.ports.runtime.countTokens(candidate, signal);
        if (tokens >= count)
          throw Error("Compacted context does not fit or did not reduce input");
        if (run.compactions.length >= 1000)
          throw Error("Compaction checkpoint limit");
        checkpoint.outputTokens = tokens;
        recordCount(tokens);
        run.compactions.push(checkpoint);
        run.compaction = null;
        run.error = null;
        this.ports.records.event(run, "compacted", {
          checkpointID: checkpoint.checkpointID,
          warnings,
          coveredThrough: checkpoint.coveredThrough,
          inputTokens: count,
          outputTokens: tokens,
          childRunID: checkpoint.childRunID,
        });
        await this.ports.storage.exclusive(() => this.ports.records.save(run));
        input.messages = candidate.messages;
        input.contextEpoch = run.compactions.length;
        return tokens < threshold
          ? true
          : this.prepareContext(run, input, capacity, signal);
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
        const retainedTokens = await this.ports.runtime.countTokens(
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
            Math.min(4096, Math.floor(threshold / 3), summaryBudget),
          ),
          inputTokens: count,
          childRunID: null,
          status: "pending",
          summary: null,
          handler: structuredClone(run.agent.compaction.handler),
        };
        this.ports.records.event(run, "compactionRequested", {
          requestID: run.compaction.requestID,
          coveredThrough,
          inputTokens: count,
        });
        await this.ports.storage.exclusive(() => this.ports.records.save(run));
      }
      const pending = run.compaction;
      if (pending.handler?.type === "agent") {
        pending.childRunID = pending.requestID;
        pending.status = "waiting";
        run.state = "paused";
        run.pauseReason = "compaction";
        this.ports.records.event(run, "paused", {
          reason: "compaction",
          childRunID: pending.childRunID,
        });
        await this.ports.storage.exclusive(() => this.ports.records.save(run));
        return false;
      }
      if (pending.handler?.type !== "exec")
        throw Error("Compaction handler unavailable");
      pending.summary = await executeCompactionScript(
        pending.handler,
        compactionRequest(run),
        signal,
      );
      pending.status = "ready";
      await this.ports.storage.exclusive(() => this.ports.records.save(run));
      return this.prepareContext(run, input, capacity, signal);
    } catch (error) {
      if (signal.aborted) throw error;
      if (error instanceof Error && error.name === "ContextPreparationError") {
        run.state = "paused";
        run.held = true;
        run.pauseReason = "runtimeError";
        run.error = {
          code: "context_preparation_failed",
          message: error.message.slice(0, 2000),
        };
        this.ports.records.event(run, "paused", {
          reason: "runtimeError",
          ...run.error,
        });
        return false;
      }
      this.toolLoop.retryCompaction(
        run,
        error instanceof Error
          ? error.message.slice(0, 1000)
          : "Compaction failed",
      );
      return false;
    }
  }
  reconcileCompactions() {
    return this.toolLoop.reconcileCompactions();
  }
}
