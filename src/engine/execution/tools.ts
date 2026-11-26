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
  validateOutput,
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
