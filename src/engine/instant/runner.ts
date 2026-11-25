import { randomUUID } from "node:crypto";
import { type Message } from "../../schemas/common.js";
import { type Event } from "../../schemas/run.js";
import { executeModelTool } from "../capabilities/registry.js";
import { withSkillCatalog } from "../capabilities/skills.js";
import { executionSlots } from "../scheduling/policy.js";
import type {
  Chat,
  Instant,
  Dependencies as ParentDependencies,
} from "./requests.js";

interface Dependencies {
  readonly dependencies: Pick<
    ParentDependencies,
    "storage" | "runtime" | "inference" | "registry" | "dispatch"
  >;
  readonly main: Pick<Instant, "chatEvent">;
}
export class InstantRunner {
  constructor(private readonly ports: Dependencies) {}
  private isInstant(c: Chat) {
    return executionSlots(this.ports.dependencies.storage.store.config).some(
      (s) =>
        s.modelID === c.input.modelID &&
        (s.slotID === c.input.slotID || c.input.slotID === "instant") &&
        s.instant,
    );
  }
  async executeChat(c: Chat, slotID: string, controller: AbortController) {
    let finishedState: Chat["state"] = "failed";
    c.state = "running";
    this.ports.main.chatEvent(c, "started", {});
    const timeout = setTimeout(
      () => controller.abort("timedOut"),
      Math.max(1, c.deadline - Date.now()),
    );
    try {
      if (c.evalOptions) {
        const input = {
          ...c.input,
          slotID,
          persistContext: false,
          sampling: c.evalOptions.sampling,
          thinking: [...c.input.messages]
            .reverse()
            .find((m) => m.role === "user")?.thinking,
        };
        if (!this.ports.dependencies.runtime.countTokens)
          throw Error("context_count_unavailable");
        const tokens = await this.ports.dependencies.runtime.countTokens(
          input,
          controller.signal,
        );
        const slot = executionSlots(
          this.ports.dependencies.storage.store.config,
        ).find((s) => s.slotID === slotID)!;
        if (tokens + input.maxOutputTokens > slot.contextTokens)
          throw Error("context_full");
        c.result = await this.ports.dependencies.runtime.generate(
          input,
          controller.signal,
          this.ports.dependencies.inference.deltas(c.requestID),
        );
        controller.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(c.result)) > 1024 * 1024)
          throw Error("output_limit");
        finishedState = "completed";
        return;
      }
      const tool = this.ports.dependencies.registry.tools.get("load_skills")!;
      const messages = withSkillCatalog(
        structuredClone(c.input.messages),
        c.skills,
      );
      const usage = { inputTokens: 0, outputTokens: 0 };
      for (let turn = 0; turn < 16; turn++) {
        const result = await this.ports.dependencies.runtime.generate(
          {
            ...c.input,
            slotID,
            messages,
            tools: [
              ...c.input.tools,
              {
                name: tool.toolID,
                description: tool.description,
                parameters: tool.parameters,
              },
            ],
            thinking: [...c.input.messages]
              .reverse()
              .find((m) => m.role === "user")?.thinking,
          },
          controller.signal,
          this.ports.dependencies.inference.deltas(c.requestID),
        );
        controller.signal.throwIfAborted();
        if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024)
          throw Error("output_limit");
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
        const assistant: Message = {
          messageID: randomUUID(),
          role: "assistant",
          content: result.text,
          ...(result.reasoningContent
            ? { reasoningContent: result.reasoningContent }
            : {}),
          attachments: [],
          toolCalls: result.toolCalls,
          toolCallID: null,
        };
        messages.push(assistant);
        c.messages.push(assistant);
        this.ports.main.chatEvent(c, "message", { message: assistant });
        const skillCalls = result.toolCalls.filter(
          (call) => call.name === "load_skills",
        );
        const clientCalls = result.toolCalls.filter(
          (call) => call.name !== "load_skills",
        );
        if (skillCalls.length && turn === 15)
          throw Error("Skill tool turn limit");
        for (const call of skillCalls) {
          const output = await executeModelTool(
            tool,
            call.arguments,
            controller.signal,
            { home: this.ports.dependencies.storage.home, skills: c.skills },
          );
          const message: Message = {
            messageID: randomUUID(),
            role: "tool",
            content: JSON.stringify(output),
            attachments: [],
            toolCalls: [],
            toolCallID: call.callID,
          };
          messages.push(message);
          c.messages.push(message);
          this.ports.main.chatEvent(c, "toolResult", { message });
        }
        if (Buffer.byteLength(JSON.stringify(c.messages)) > 4 * 1024 * 1024)
          throw Error("Skill tool context limit");
        if (!skillCalls.length || clientCalls.length) {
          c.result = { ...result, toolCalls: clientCalls, usage };
          break;
        }
      }
      if (!c.result) throw Error("Inference did not complete");
      finishedState = "completed";
    } catch (error) {
      finishedState = controller.signal.aborted
        ? controller.signal.reason === "timedOut"
          ? "timedOut"
          : "cancelled"
        : "failed";
      const evalCode =
        c.evalOptions && error instanceof Error
          ? (
              {
                context_full: "context_full",
                context_count_unavailable: "context_count_unavailable",
                "Incomplete generation": "output_incomplete",
                output_limit: "output_limit",
              } as Record<string, string>
            )[error.message]
          : undefined;
      c.error = {
        code: evalCode ?? finishedState,
        message: evalCode ?? "Inference did not complete",
      };
    } finally {
      clearTimeout(timeout);
      c.expires = Date.now() + 900000;
      try {
        if (this.isInstant(c))
          await this.ports.dependencies.storage.exclusive(() =>
            this.ports.dependencies.dispatch.recordInteraction(),
          );
      } catch (error) {
        finishedState = "failed";
        c.error = {
          code: "cooldown_persistence_failed",
          message: "Unable to persist interaction cooldown",
        };
        throw error;
      } finally {
        // Clients may act on terminal responses immediately. Publish only after
        // cooldown is durable, so a slow model load cannot consume the warm window.
        c.state = finishedState;
        this.ports.main.chatEvent(
          c,
          finishedState as Event["type"],
          finishedState === "completed" ? c.result! : {},
        );
      }
    }
  }
}
