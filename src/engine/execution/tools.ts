import { overrideTool } from "../evals/tools.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type Message } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import type { AgentRegistry } from "../capabilities/registry.js";
import { executeModelTool } from "../capabilities/registry.js";
import {
  DuplicateJSONKeyError,
  parseOutputJSON,
} from "../supervision.js";
import type { Context } from "./context.js";

interface Dependencies {
  readonly registry: Pick<AgentRegistry, "agentToolIDs" | "tools" | "runTools">;
  readonly storage: Storage;
  readonly records: Pick<RunRecords, "event" | "save">;
  readonly context: Pick<Context, "atStorageLimit">;
}
export class ToolExecution {
  constructor(private readonly ports: Dependencies) {}
  async invokeTool(r: Run, name: string, args: string, signal: AbortSignal) {
    if (
      r.agent.finishSchema &&
      (name === "finish" ||
        r.agent.mode === "singleTurn" ||
        (r.toolLoop?.turnID === r.turnID && r.toolLoop.finalizing))
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
    if (r.evaluation)
      return overrideTool(definition, name, args, r.evaluation.definition);
    return executeModelTool(definition, args, signal, {
      home: this.ports.storage.home,
      agentID: r.agent.agentID,
      runID: r.runID,
      ...(name === "load_skills" ? { skills: r.skills } : {}),
    });
  }
  async resumeTools(
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
          const verdict = {
            turnID: r.turnID,
            messageID: lastAssistant.messageID,
            status: error ? "failed" as const : "passed" as const,
            reason: error ?? "finishSchema passed; factual accuracy is not implied.",
            at: new Date().toISOString(),
          } as import("zod").z.infer<typeof import("../supervision.js").validationRecordSchema>;
          r.validations.push(verdict);
          this.ports.records.event(r, "outputValidation", {
            messageID: verdict.messageID, status: verdict.status, reason: verdict.reason,
          });
          for (const resultCall of error ? lastAssistant.toolCalls : [call]) {
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
              toolCallID: resultCall.callID,
            };
            r.messages.push(receipt);
            this.ports.records.event(r, "toolResult", {
              messageID: receipt.messageID,
            });
          }
          if (error) {
            r.state = "invalidOutput";
            r.error = { code: "invalid_finish", message: error };
            this.ports.records.event(r, "invalidOutput", {});
          } else {
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
          break;
        }
        if (this.ports.context.atStorageLimit(r)) break;
        if (r.messages.some((m) => m.toolCallID === call.callID)) continue;
        if (controller.signal.aborted) break;
        if (
          r.events.some(
            (e) => e.type === "toolStarted" && e.data.callID === call.callID,
          )
        ) {
          r.state = "paused";
          r.held = true;
          r.pauseReason = "runtimeError";
          r.error = {
            code: "tool_outcome_unknown",
            message:
              "Tool execution started but no result was committed. Inspect the destination before submitting more work; this call will not be replayed.",
          };
          this.ports.records.event(r, "paused", {
            reason: "runtimeError",
            code: r.error.code,
            message: r.error.message,
          });
          await this.ports.storage.exclusive(() => this.ports.records.save(r));
          break;
        }
        this.ports.records.event(r, "toolStarted", {
          callID: call.callID,
          name: call.name,
        });
        await this.ports.storage.exclusive(() => this.ports.records.save(r));
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
          content:
            r.evaluation && typeof output === "string"
              ? output
              : JSON.stringify(output),
          attachments: [],
          toolCalls: [],
          toolCallID: call.callID,
        };
        r.messages.push(m);
        this.ports.records.event(r, "toolResult", { messageID: m.messageID });
        await this.ports.storage.exclusive(() => this.ports.records.save(r));
      }
  }
}
