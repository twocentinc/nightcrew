import { createHash, randomUUID } from "node:crypto";
import type { RunRecords } from "../storage/records.js";
import { Storage } from "../storage/store.js";
import type { Context } from "./context.js";
import { type Run } from "./contracts.js";
import type { AgentRegistry } from "./registry.js";
import type { TurnHistory } from "./response.js";
import type { Runtime } from "./runtimeTypes.js";
import { loopProblem } from "./supervision.js";

interface Dependencies {
  readonly records: Pick<RunRecords, "event" | "save">;
  readonly storage: Storage;
  readonly context: Pick<Context, "runMessages">;
  readonly registry: Pick<AgentRegistry, "runTools">;
}
export class RequestBuilder {
  constructor(private readonly ports: Dependencies) {}
  async prepareTurn(
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
}
export interface PreparedTurn {
  input: Parameters<Runtime["generate"]>[0];
  thinking: boolean;
  finalizing: boolean;
}
