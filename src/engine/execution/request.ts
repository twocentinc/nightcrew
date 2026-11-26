import { createHash, randomUUID } from "node:crypto";
import { type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import type { AgentRegistry } from "../capabilities/registry.js";
import type { Runtime } from "../models/types.js";
import { loopProblem } from "../supervision.js";
import type { Context } from "./context.js";
import type { TurnHistory } from "./response.js";

interface Dependencies {
  readonly records: Pick<RunRecords, "event" | "save">;
  readonly storage: Storage;
  readonly context: Pick<Context, "runMessages">;
  readonly registry: Pick<AgentRegistry, "runTools">;
}
export class RequestBuilder {
  constructor(private readonly ports: Dependencies) {}
  async prepareTurn(r: Run, slotID: string, history: TurnHistory) {
    const {
      currentMessages,
      lastAssistant,
      continuation,
      prefix,
      priorReasoning,
    } = history;
    const turnMessages = r.messages.slice(
      r.messages.map((m) => m.role).lastIndexOf("user") + 1,
    );
    const toolLoop = r.toolLoop?.turnID === r.turnID ? r.toolLoop : null;
    const afterToolLoop = toolLoop
      ? turnMessages.slice(
          turnMessages.findIndex(
            (m) => m.messageID === toolLoop.afterMessageID,
          ) + 1,
        )
      : turnMessages;
    const problem =
      toolLoop && !afterToolLoop.some((m) => m.role === "tool")
        ? null
        : loopProblem(
            turnMessages,
            toolLoop
              ? { ...r.agent.loopPolicy, consecutiveErrors: 1 }
              : r.agent.loopPolicy,
          );
    if (problem) {
      if (!toolLoop) {
        r.toolLoop = {
          turnID: r.turnID,
          afterMessageID: turnMessages.at(-1)!.messageID,
          reason: problem,
          finalizing: false,
        };
        this.ports.records.event(r, "toolLoopUpdated", {
          reason: problem,
          finalizing: false,
        });
      } else if (!toolLoop.finalizing) {
        toolLoop.finalizing = true;
        this.ports.records.event(r, "toolLoopUpdated", {
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
      (r.toolLoop?.turnID !== r.turnID || !r.toolLoop.finalizing)
    ) {
      r.toolLoop = {
        turnID: r.turnID,
        afterMessageID: turnMessages.at(-1)!.messageID,
        reason:
          "Tool-call budget exhausted before the agent returned a final answer",
        finalizing: true,
      };
      this.ports.records.event(r, "toolLoopUpdated", {
        reason: r.toolLoop.reason,
        finalizing: true,
      });
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
    }
    const emptyAnswer =
      r.agent.mode === "agentLoop" &&
      !!lastAssistant &&
      !lastAssistant.toolCalls.length &&
      !lastAssistant.content.trim();
    const finalizing =
      budgetExhausted ||
      emptyAnswer ||
      (r.toolLoop?.turnID === r.turnID && r.toolLoop.finalizing);
    const thinking =
      finalizing || continuation.length > 0
        ? false
        : ([...r.messages].reverse().find((m) => m.role === "user")?.thinking ??
          r.agent.thinking);
    const messages = this.ports.context.runMessages(r);
    if (r.agent.finishSchema) {
      const instruction =
        "You must complete this turn by calling the runtime-owned finish tool with the final result. Ordinary text does not complete the task. Call finish alone, never alongside another tool. finish has no executable or external side effects. Do not call it until your work is ready. An invalid finish call fails the run immediately; there is no correction attempt. After ordinary tools are exhausted, finish remains available. ";
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
      r.toolLoop?.turnID === r.turnID &&
      !r.toolLoop.finalizing &&
      !finalizing
    )
      messages.push({
        messageID: randomUUID(),
        role: "user",
        content:
          "Nightcrew tool-loop correction opportunity: " +
          r.toolLoop.reason +
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
          (r.toolLoop?.finalizing
            ? "Nightcrew stopped unproductive tool use: " + r.toolLoop.reason
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
          : !r.evaluation && r.agent.contextMode === "persistent"
            ? "agent-" +
              createHash("sha256").update(r.agent.agentID).digest("hex")
            : "run-" + r.runID,
      persistContext: r.agent.contextMode === "persistent",
      contextEpoch: r.compactions.length,
      messages,
      tools: [
        ...(finalizing ||
        (r.agent.finishSchema && r.agent.mode === "singleTurn") ||
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
      parallelToolCalls: r.agent.parallelToolCalls,
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
