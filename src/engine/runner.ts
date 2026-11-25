import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RunRecords } from "../storage/records.js";
import { Storage } from "../storage/store.js";
import type { Context } from "./context.js";
import { now, terminal, type Message, type Run } from "./contracts.js";
import type { Dispatch } from "./dispatch.js";
import type { Hooks } from "./hooks.js";
import type { AgentRegistry } from "./registry.js";
import { executeModelTool } from "./registry.js";
import type { Attempt, Result, Runtime } from "./runtimeTypes.js";
import { executionSlots } from "./scheduler.js";
import {
  DuplicateJSONKeyError,
  loopProblem,
  parseOutputJSON,
  validateOutput,
} from "./supervision.js";

interface Dependencies {
  readonly storage: Storage;
  readonly records: Pick<RunRecords, "run" | "save" | "event">;
  readonly context: Pick<
    Context,
    "atStorageLimit" | "pauseForStorage" | "runMessages" | "prepareContext"
  >;
  readonly registry: Pick<AgentRegistry, "runTools" | "agentToolIDs" | "tools">;
  readonly runtime: Runtime;
  readonly dispatch: Pick<Dispatch, "recordInteraction">;
  readonly hooks: Pick<Hooks, "scheduleHooks">;
}
export class Runner {
  constructor(private readonly ports: Dependencies) {}
  private liveRuns = new Map<string, Run>();
  readonly provisional = new Map<string, { attemptID: string; text: string }>();
  deltas(id: string) {
    const value = { attemptID: randomUUID(), text: "" };
    this.provisional.set(id, value);
    return (text: string) => {
      if (Buffer.byteLength(value.text) + Buffer.byteLength(text) > 1048576)
        throw Error("Output limit");
      value.text += text;
    };
  }
  private responseContinuation(run: Run) {
    const chunks: Attempt[] = [];
    for (const attempt of [...run.attempts].reverse()) {
      if (attempt.segment !== run.segment || attempt.messageID) break;
      if (attempt.reason === "output_limit") chunks.unshift(attempt);
    }
    return chunks;
  }
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
        const continuation = this.responseContinuation(r);
        const prefix = continuation.map((a) => a.text).join("");
        const priorReasoning = continuation
          .map((a) => a.reasoningContent)
          .join("");
        // A finish response is exclusive: never execute siblings in a mixed batch.
        const finishBatch =
          !!r.agent.finishSchema &&
          !!lastAssistant?.toolCalls.some((c) => c.name === "finish");
        await this.resumeTools(
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
        const validation = await this.validateFinal(
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
        const prepared = await this.prepareTurn(
          r,
          slotID,
          history,
          validation.repairReason,
        );
        const { input, thinking } = prepared;
        if (
          !(await this.ports.context.prepareContext(
            r,
            input,
            configuredSlot.contextTokens,
            controller.signal,
          ))
        )
          break;
        const attempt = await this.startAttempt(r, thinking, state);
        const result = await this.generate(
          runID,
          input,
          controller,
          attempt,
          thinking,
        );
        if (controller.signal.aborted) break;
        await this.recordOutput(r, runID, result, history, prepared, state);
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
      this.settleInterrupted(r, controller, state);
      clearInterval(timer);
      clearTimeout(slice);
      await checkpointWork;
      charge();
      await this.finishRun(r, runID, configuredSlot.instant);
    }
  }
  private async invokeTool(
    r: Run,
    name: string,
    args: string,
    signal: AbortSignal,
  ) {
    if (
      r.agent.finishSchema &&
      (name === "finish" ||
        r.agent.mode === "single-turn" ||
        (r.recovery?.segment === r.segment && r.recovery.finalizing))
    )
      return {
        ok: false,
        error: {
          code: "tool_not_available",
          message: "Use the runtime-owned finish tool to complete this run.",
        },
      };
    const definition =
      this.ports.registry.agentToolIDs(r.agent).includes(name) &&
      this.ports.registry.tools.has(name)
        ? this.ports.registry.runTools(r).find((t) => t.toolID === name)
        : undefined;
    return executeModelTool(definition, args, signal, {
      home: this.ports.storage.home,
      agentID: r.agent.agentID,
      runID: r.runID,
      ...(name === "load_skills" ? { skills: r.skills } : {}),
    });
  }
  private async resumeTools(
    r: Run,
    currentMessages: Message[],
    lastAssistant: Message | undefined,
    finishBatch: boolean,
    controller: AbortController,
  ) {
    if (lastAssistant)
      for (const call of lastAssistant.toolCalls) {
        if (r.agent.finishSchema && finishBatch) {
          if (r.messages.some((m) => m.toolCallID === call.callID)) continue;
          if (controller.signal.aborted) break;
          let error: string | null =
            lastAssistant.toolCalls.length === 1
              ? null
              : "finish must be the only call in its response; no calls in this batch were executed";
          let value: unknown;
          if (!error) {
            try {
              value = parseOutputJSON(call.arguments);
              const parsed = z
                .fromJSONSchema(r.agent.finishSchema)
                .safeParse(value);
              if (!parsed.success)
                error = parsed.error.issues
                  .map((i) => `${i.path.join(".")}: ${i.message}`)
                  .join("; ")
                  .slice(0, 2000);
            } catch (cause) {
              error =
                cause instanceof DuplicateJSONKeyError
                  ? cause.message.slice(0, 2000)
                  : "finish arguments must be valid JSON matching the configured schema";
            }
          }
          const finalMessage: Message = {
            messageID: randomUUID(),
            role: "assistant",
            content: JSON.stringify(value) ?? "",
            attachments: [],
            toolCalls: [],
            toolCallID: null,
          };
          if (!error && r.agent.outputValidation) {
            const verdict = await validateOutput(
              r,
              { ...finalMessage, messageID: lastAssistant.messageID },
              this.ports.storage.home,
              controller.signal,
            );
            r.validations.push(verdict);
            this.ports.records.event(r, "outputValidation", {
              messageID: lastAssistant.messageID,
              status: verdict.status,
              reason: verdict.reason,
            });
            if (verdict.status !== "passed") error = verdict.reason;
          }
          const receipt: Message = {
            messageID: randomUUID(),
            role: "tool",
            content: JSON.stringify(
              error
                ? {
                    ok: false,
                    error: { code: "invalid_finish", message: error },
                  }
                : { ok: true, finished: true },
            ),
            attachments: [],
            toolCalls: [],
            toolCallID: call.callID,
          };
          r.messages.push(receipt);
          this.ports.records.event(r, "toolResult", {
            messageID: receipt.messageID,
          });
          if (!error) {
            r.messages.push(finalMessage);
            this.ports.records.event(r, "message", {
              messageID: finalMessage.messageID,
            });
            r.state = "completed";
            r.result = finalMessage.content;
            this.ports.records.event(r, "completed", {
              messageID: finalMessage.messageID,
            });
          }
          // Receipt, final result and terminal state commit together, so restart cannot replay finish.
          await this.ports.storage.exclusive(() => this.ports.records.save(r));
          if (!error) break;
          continue;
        }
        if (this.ports.context.atStorageLimit(r)) break;
        if (r.messages.some((m) => m.toolCallID === call.callID)) continue;
        if (controller.signal.aborted) break;
        const callIndex = currentMessages
          .flatMap((m) =>
            m.toolCalls.filter(
              (c) => !r.agent.finishSchema || c.name !== "finish",
            ),
          )
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
        this.ports.records.event(r, "toolResult", { messageID: m.messageID });
        await this.ports.storage.exclusive(() => this.ports.records.save(r));
      }
  }
  private async validateFinal(
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
  private async prepareTurn(
    r: Run,
    slotID: string,
    history: TurnHistory,
    repairReason: string | null,
  ) {
    const {
      currentMessages,
      lastAssistant,
      continuation,
      prefix,
      priorReasoning,
      finishBatch,
    } = history;
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
        this.ports.records.event(r, "loopRecovery", {
          reason: problem,
          finalizing: false,
        });
      } else if (!recovery.finalizing) {
        recovery.finalizing = true;
        this.ports.records.event(r, "loopRecovery", {
          reason: problem,
          finalizing: true,
        });
      }
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
    }
    const budgetExhausted =
      r.agent.maxToolCalls !== undefined &&
      currentMessages.reduce(
        (count, m) =>
          count +
          m.toolCalls.filter(
            (c) => !r.agent.finishSchema || c.name !== "finish",
          ).length,
        0,
      ) >= r.agent.maxToolCalls;
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
      this.ports.records.event(r, "loopRecovery", {
        reason: r.recovery.reason,
        finalizing: true,
      });
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
    }
    const emptyAnswer =
      r.agent.mode === "agent-loop" &&
      !!lastAssistant &&
      !lastAssistant.toolCalls.length &&
      !lastAssistant.content.trim();
    const finishCorrection =
      !!r.agent.finishSchema &&
      !!lastAssistant &&
      (!lastAssistant.toolCalls.length || finishBatch);
    if (
      finishCorrection &&
      (!r.recovery ||
        r.recovery.segment !== r.segment ||
        !r.recovery.finalizing)
    )
      r.recovery = {
        segment: r.segment,
        afterMessageID: lastAssistant!.messageID,
        reason:
          "Return a valid finish call; ordinary text and invalid calls do not complete the run",
        finalizing: true,
      };
    const finalizing =
      finishCorrection ||
      budgetExhausted ||
      emptyAnswer ||
      !!repairReason ||
      (r.recovery?.segment === r.segment && r.recovery.finalizing);
    const thinking =
      finalizing || continuation.length > 0
        ? false
        : ([...r.messages].reverse().find((m) => m.role === "user")?.thinking ??
          r.agent.thinking);
    const messages = this.ports.context.runMessages(r);
    if (r.agent.finishSchema) {
      const instruction =
        "You must complete this turn by calling the runtime-owned finish tool with the final result. Ordinary text does not complete the task. Call finish alone, never alongside another tool. finish has no executable or external side effects. Do not call it until your work is ready. Invalid finish calls receive validation feedback; you have at most three completion attempts. After ordinary tools are exhausted, finish remains available. ";
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
              ? "Nightcrew stopped unproductive tool use: " + r.recovery.reason
              : budgetExhausted
                ? "Nightcrew execution limit: your tool-call budget for this turn is exhausted."
                : "Nightcrew finalization: the previous generation contained no visible answer.") +
          (r.agent.finishSchema
            ? " Only finish is available. Call finish with your final result using only"
            : " No more tools are available. Return your final answer now using only") +
          " the original tool evidence already collected. State limitations rather than inventing missing facts. Thinking drafts are not verified evidence. Preserve the configured output format, including JSON when required.",
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      });
    const continueFinalMessage =
      !!prefix && !continuation.at(-1)?.toolCalls.length;
    if (continueFinalMessage) {
      // Keep the exact prefix inside the open assistant message. A new user
      // turn can make the model omit punctuation at the chunk boundary.
      if (messages.at(-1)?.role === "assistant")
        messages.push({
          messageID: randomUUID(),
          role: "user",
          content: "Complete the unfinished answer in the required format.",
          attachments: [],
          toolCalls: [],
          toolCallID: null,
        });
      messages.push({
        messageID: randomUUID(),
        role: "assistant",
        content: prefix,
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      });
    } else if (continuation.length) {
      const partialTools = continuation.at(-1)!.toolCalls;
      messages.push(
        {
          messageID: randomUUID(),
          role: "assistant",
          content:
            prefix ||
            (priorReasoning
              ? "Unfinished reasoning draft (not verified evidence):\n" +
                priorReasoning
              : "The previous generation stopped during a tool call."),
          attachments: [],
          toolCalls: [],
          toolCallID: null,
        },
        {
          messageID: randomUUID(),
          role: "user",
          content:
            "Nightcrew output continuation: the previous generation reached its per-response token limit. " +
            (partialTools.length
              ? "The unfinished tool calls below were NOT executed. Emit the required complete tool calls again from scratch; never execute partial arguments. Fragments: " +
                JSON.stringify(partialTools) +
                ". "
              : prefix
                ? "Continue the answer EXACTLY where the assistant text ends. Emit only the remaining text, including any needed leading whitespace. Do not repeat, restart, summarize, add a preamble, or wrap JSON in fences. Your text will be appended verbatim to the saved prefix. No more tools are available for this answer. "
                : "Finish the reasoning and return the answer or complete tool calls. The draft is not a final answer. ") +
            "Preserve the required output format and evidence qualifications.",
          attachments: [],
          toolCalls: [],
          toolCallID: null,
        },
      );
    }
    const input: Parameters<Runtime["generate"]>[0] = {
      continueOnOutputLimit: true,
      continueFinalMessage,
      modelID: r.agent.modelID,
      slotID,
      contextID:
        this.ports.storage.store.config.models.find(
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
      tools: [
        ...(finalizing ||
        (r.agent.finishSchema && r.agent.mode === "single-turn") ||
        (prefix && !continuation.at(-1)?.toolCalls.length)
          ? []
          : this.ports.registry.runTools(r)
        ).map((t) => ({
          name: t.toolID,
          description: t.description,
          parameters: t.parameters,
        })),
        ...(r.agent.finishSchema
          ? [
              {
                name: "finish",
                description:
                  "Complete the run with the final result. Call alone. Nightcrew validates arguments; this tool executes no executable code.",
                parameters: r.agent.finishSchema,
              },
            ]
          : []),
      ],
      thinking,
      ...(r.parentRunID && thinking
        ? {
            reasoningBudgetTokens: Math.min(
              1024,
              Math.floor(r.agent.maxOutputTokens / 2),
            ),
          }
        : {}),
      maxOutputTokens: r.agent.maxOutputTokens,
      temperature: r.agent.temperature,
      sampling: r.agent.sampling,
    };
    return { input, thinking, finalizing };
  }
  private async startAttempt(r: Run, thinking: boolean, state: RunExecution) {
    state.attempt = {
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
    r.attempts.push(state.attempt);
    this.ports.records.event(r, "attempt", {
      attemptID: state.attempt.attemptID,
    });
    await this.ports.storage.exclusive(() => this.ports.records.save(r));
    return state.attempt!;
  }
  private async generate(
    runID: string,
    input: Parameters<Runtime["generate"]>[0],
    controller: AbortController,
    attempt: Attempt,
    thinking: boolean,
  ) {
    const delta = this.deltas(runID);
    const result = await this.ports.runtime.generate(
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
    return result;
  }
  private async recordOutput(
    r: Run,
    runID: string,
    result: Result,
    history: TurnHistory,
    prepared: PreparedTurn,
    state: RunExecution,
  ) {
    const { continuation, prefix, priorReasoning } = history;
    const { thinking, finalizing } = prepared;
    const attempt = state.attempt!;
    if (r.contextUsage) {
      r.contextUsage = {
        ...r.contextUsage,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        measuredAt: now(),
        segment: r.segment,
      };
    }
    if (result.outputLimitReached) {
      // These attempts are durable continuation chunks, not complete messages.
      // They survive interruption/restart/compaction without completing the run
      // or executing unfinished tool calls. No new user turn/budget is created.
      attempt.text = result.text;
      attempt.reasoningContent = thinking
        ? (result.reasoningContent ?? "")
        : "";
      attempt.status = "interrupted";
      attempt.reason = "output_limit";
      attempt.updatedAt = now();
      state.attempt = undefined;
      this.provisional.delete(runID);
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
      if (
        !attempt.text &&
        !attempt.reasoningContent &&
        !attempt.toolCalls.length
      )
        throw Error("Output continuation made no progress");
      if (
        Buffer.byteLength(prefix + attempt.text) > 1048576 ||
        Buffer.byteLength(priorReasoning + attempt.reasoningContent) > 1048576
      )
        throw Error("Assembled response exceeds storage limit");
      return;
    }
    const content = prefix + result.text;
    const reasoningContent =
      priorReasoning + (thinking ? (result.reasoningContent ?? "") : "");
    if (
      Buffer.byteLength(content) > 1048576 ||
      Buffer.byteLength(reasoningContent) > 1048576
    )
      throw Error("Assembled response exceeds storage limit");
    const m: Message = {
      messageID: randomUUID(),
      role: "assistant",
      content,
      thinking: thinking || continuation.some((a) => a.thinking),
      ...(reasoningContent ? { reasoningContent } : {}),
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
    if (state.attempt) {
      state.attempt.status = "completed";
      state.attempt.messageID = m.messageID;
      state.attempt.updatedAt = now();
      state.attempt.text = "";
      state.attempt.reasoningContent = "";
      state.attempt.toolCalls = [];
      state.attempt = undefined;
    }
    this.provisional.delete(runID);
    this.ports.records.event(r, "message", { messageID: m.messageID });
    if (!result.toolCalls.length) {
      if (r.agent.mode === "agent-loop" && !result.text.trim()) {
        if (finalizing) throw Error("Model returned no visible final answer");
        await this.ports.storage.exclusive(() => this.ports.records.save(r));
        return;
      }
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
      return;
    }
    if (finalizing && !r.agent.finishSchema)
      throw Error("Model requested tools during tool-free finalization");
    if (r.agent.mode === "single-turn" && !r.agent.finishSchema)
      throw Error("Unexpected tools");
    await this.ports.storage.exclusive(() => this.ports.records.save(r));
  }
  private settleInterrupted(
    r: Run,
    controller: AbortController,
    state: RunExecution,
  ) {
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
  private async finishRun(r: Run, runID: string, instant: boolean) {
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
    this.liveRuns.delete(runID);
    if (finishedState) this.ports.hooks.scheduleHooks(r, finishedState);
    if (storagePaused) this.ports.hooks.scheduleHooks(r, "storageLimit");
  }

  liveRun(id: string) {
    return this.liveRuns.get(id);
  }
  clearProvisional(id: string) {
    this.provisional.delete(id);
  }
}

interface RunExecution {
  attempt?: Attempt;
}
interface TurnHistory {
  currentMessages: Message[];
  lastAssistant: Message | undefined;
  continuation: Attempt[];
  prefix: string;
  priorReasoning: string;
  finishBatch: boolean;
}
interface PreparedTurn {
  input: Parameters<Runtime["generate"]>[0];
  thinking: boolean;
  finalizing: boolean;
}
