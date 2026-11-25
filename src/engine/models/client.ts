import { z } from "zod";
import { NightcrewError } from "../protocol.js";
import type { ModelCache } from "./cache.js";
import type { LlamaRuntime } from "./runtime.js";
import type { ModelServer } from "./server.js";
import { readStream } from "./stream.js";
import type { Result, Runtime } from "./types.js";

interface Dependencies {
  readonly main: Pick<
    LlamaRuntime,
    | "busy"
    | "used"
    | "idleTimer"
    | "provisioning"
    | "prepare"
    | "scheduleIdle"
    | "config"
    | "resident"
    | "release"
    | "loadedModel"
    | "logger"
  >;
  readonly server: Pick<ModelServer, "baseURL" | "headers" | "key">;
  readonly cache: Pick<
    ModelCache,
    | "owners"
    | "contextEpochs"
    | "eraseSlot"
    | "slotAction"
    | "transientSlots"
    | "pruneSnapshots"
  >;
}
export class ModelClient {
  constructor(private readonly ports: Dependencies) {}
  private formatMessages(
    messages: Parameters<Runtime["generate"]>[0]["messages"],
  ) {
    return messages.map((m) => ({
      role: m.role,
      content:
        m.content +
        m.attachments
          .map(
            (a) =>
              `\n\nAttachment ${JSON.stringify(a.name)} (${a.mediaType}):\n${Buffer.from(a.dataBase64, "base64").toString("utf8")}`,
          )
          .join(""),
      ...(m.toolCalls.length
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.callID,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
      ...(m.toolCallID ? { tool_call_id: m.toolCallID } : {}),
    }));
  }
  async countTokens(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
  ): Promise<number> {
    if (
      this.ports.main.busy ||
      this.ports.main.used.has(input.slotID) ||
      [...this.ports.main.used.values()].some((m) => m !== input.modelID)
    )
      throw Error("Runtime busy");
    this.ports.main.used.set(input.slotID, input.modelID);
    clearTimeout(this.ports.main.idleTimer);
    try {
      const prepare = this.ports.main.provisioning.then(() =>
        this.ports.main.prepare(input.modelID, signal),
      );
      this.ports.main.provisioning = prepare.catch(() => {});
      await prepare;
      const post = async (endpoint: string, body: object) => {
        const response = await fetch(this.ports.server.baseURL + endpoint, {
          method: "POST",
          headers: this.ports.server.headers(),
          signal,
          body: JSON.stringify({ model: input.modelID, ...body }),
        });
        if (!response.ok) {
          const reader = response.body?.getReader();
          let detail = "";
          if (reader) {
            try {
              while (detail.length < 4000) {
                const chunk = await reader.read();
                if (chunk.done) break;
                detail += Buffer.from(chunk.value).toString("utf8");
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
          }
          const error = new Error(
            `Context preparation ${endpoint} returned HTTP ${response.status}: ${detail.slice(0, 1500) || response.statusText}`,
          );
          error.name = "ContextPreparationError";
          throw error;
        }
        return response.json();
      };
      const template = z.object({ prompt: z.string() }).parse(
        await post("/apply-template", {
          messages: this.formatMessages(input.messages),
          tools: input.tools.map((t) => ({ type: "function", function: t })),
          ...(input.sampling?.parallelToolCalls === undefined
            ? {}
            : { parallel_tool_calls: input.sampling.parallelToolCalls }),
          add_generation_prompt: !input.continueFinalMessage,
          ...(input.continueFinalMessage
            ? { continue_final_message: "content" }
            : {}),
          chat_template_kwargs: { enable_thinking: input.thinking ?? true },
        }),
      );
      const tokens = z.object({ tokens: z.array(z.number()) }).parse(
        await post("/tokenize", {
          content: template.prompt,
          add_special: false,
          parse_special: true,
        }),
      );
      return tokens.tokens.length;
    } catch (cause) {
      signal.throwIfAborted();
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.name = "ContextPreparationError";
      throw error;
    } finally {
      this.ports.main.used.delete(input.slotID);
      if (!this.ports.main.used.size)
        this.ports.main.scheduleIdle(input.modelID);
    }
  }
  async generate(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onEvidence?: Parameters<Runtime["generate"]>[3],
  ): Promise<Result> {
    if (
      this.ports.main.busy ||
      this.ports.main.used.has(input.slotID) ||
      [...this.ports.main.used.values()].some(
        (model) => model !== input.modelID,
      )
    )
      throw new NightcrewError(
        "runtime.busy",
        "Requested model or slot is busy",
        9,
      );
    this.ports.main.used.set(input.slotID, input.modelID);
    clearTimeout(this.ports.main.idleTimer);
    try {
      const prepare = this.ports.main.provisioning.then(() =>
        this.ports.main.prepare(input.modelID, signal),
      );
      this.ports.main.provisioning = prepare.catch(() => {});
      await prepare;
      signal.throwIfAborted();
      if (
        input.contextID &&
        (this.ports.cache.owners.get(input.slotID) !== input.contextID ||
          this.ports.cache.contextEpochs.get(input.slotID) !==
            (input.contextEpoch ?? 0))
      ) {
        await this.ports.cache.eraseSlot(input.slotID, signal);
        this.ports.cache.owners.delete(input.slotID);
        if (
          input.persistContext !== false &&
          this.ports.main.config().scheduler.snapshotBudgetMB > 0 &&
          this.ports.main
            .config()
            .models.find((m) => m.modelID === input.modelID)?.slotSnapshots
            .enabled
        ) {
          try {
            await this.ports.cache.slotAction(
              input.slotID,
              "restore",
              signal,
              input.contextID,
              input.contextEpoch,
            );
          } catch (error) {
            signal.throwIfAborted();
            if (
              error instanceof NightcrewError &&
              error.code === "runtime.snapshotResetFailed"
            )
              throw error;
          }
        }
        this.ports.cache.owners.set(input.slotID, input.contextID);
        this.ports.cache.contextEpochs.set(
          input.slotID,
          input.contextEpoch ?? 0,
        );
      } else if (!input.contextID) this.ports.cache.owners.delete(input.slotID);
      if (input.persistContext === false)
        this.ports.cache.transientSlots.add(input.slotID);
      else this.ports.cache.transientSlots.delete(input.slotID);
      const slot = this.ports.main
        .config()
        .slots.find(
          (s) => s.slotID === input.slotID && s.modelID === input.modelID,
        );
      if (!slot) throw Error("Unknown slot");
      this.ports.main.resident.clear();
      this.ports.main.resident.set(input.modelID, "ready");
      const model = this.ports.main
        .config()
        .models.find((m) => m.modelID === input.modelID)!;
      let response: Response;
      if (model.kind === "audio") {
        const a = input.messages
          .at(-1)
          ?.attachments.find((x) => x.mediaType === "audio/wav");
        if (!a) throw Error("WAV required");
        const form = new FormData();
        form.set("model", input.modelID);
        const prompt = [...input.messages]
          .reverse()
          .find((m) => m.role === "user")?.content;
        if (prompt?.trim()) form.set("prompt", prompt);
        form.set("response_format", "json");
        form.set("temperature", String(input.temperature));
        form.set("max_tokens", String(input.maxOutputTokens));
        form.set(
          "file",
          new Blob([Uint8Array.from(Buffer.from(a.dataBase64, "base64"))], {
            type: "audio/wav",
          }),
          "input.wav",
        );
        response = await fetch(
          this.ports.server.baseURL + "/v1/audio/transcriptions",
          {
            method: "POST",
            headers: { Authorization: `Bearer ${this.ports.server.key}` },
            body: form,
            signal,
          },
        );
      } else {
        const messages = this.formatMessages(input.messages);
        response = await fetch(
          this.ports.server.baseURL + "/v1/chat/completions",
          {
            method: "POST",
            headers: this.ports.server.headers(),
            signal,
            body: JSON.stringify({
              model: input.modelID,
              id_slot: slot.index,
              cache_prompt: true,
              ...(input.continueFinalMessage
                ? {
                    continue_final_message: "content",
                    add_generation_prompt: false,
                  }
                : {}),
              messages,
              tools: input.tools.map((t) => ({
                type: "function",
                function: t,
              })),
              tool_choice: input.tools.length ? "auto" : "none",
              ...(input.thinking === undefined
                ? {}
                : {
                    chat_template_kwargs: { enable_thinking: input.thinking },
                  }),
              ...(input.reasoningBudgetTokens === undefined
                ? {}
                : { reasoning_budget_tokens: input.reasoningBudgetTokens }),
              max_tokens: input.maxOutputTokens,
              temperature: input.temperature,
              ...(input.sampling
                ? {
                    top_p: input.sampling.topP,
                    top_k: input.sampling.topK,
                    min_p: input.sampling.minP,
                    presence_penalty: input.sampling.presencePenalty,
                    repeat_penalty: input.sampling.repeatPenalty,
                    parallel_tool_calls: input.sampling.parallelToolCalls,
                  }
                : {}),
              stream: true,
              stream_options: { include_usage: true },
            }),
          },
        );
      }
      if (!response.ok) throw Error("Model request failed");
      if (!response.body) throw Error("Empty model response");
      if (model.kind === "chat")
        return await readStream(
          response,
          signal,
          onDelta,
          input.thinking !== false,
          onEvidence,
          input.continueOnOutputLimit,
        );
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 2 * 1024 * 1024) throw Error("Model output limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const parsed = z.object({ text: z.string().max(1048576) }).parse(data);
      return {
        text: parsed.text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } catch (e) {
      if (signal.aborted) {
        await this.ports.main.release(input.modelID, input.slotID);
      } else {
        await this.ports.main.release(input.modelID, input.slotID);
      }
      throw e;
    } finally {
      if (
        input.contextID &&
        input.persistContext !== false &&
        this.ports.cache.owners.get(input.slotID) === input.contextID &&
        this.ports.main.config().scheduler.snapshotBudgetMB > 0 &&
        this.ports.main.config().models.find((m) => m.modelID === input.modelID)
          ?.slotSnapshots.enabled &&
        this.ports.main.loadedModel === input.modelID
      ) {
        try {
          await this.ports.cache.slotAction(
            input.slotID,
            "save",
            AbortSignal.timeout(5000),
            input.contextID,
            input.contextEpoch,
          );
          await this.ports.cache.pruneSnapshots();
        } catch {
          this.ports.main.logger?.emit("slot.snapshotSaveFailed", {
            slotID: input.slotID,
            reason: "transport",
          });
        }
      }
      this.ports.main.used.delete(input.slotID);
      if (!this.ports.main.used.size)
        this.ports.main.scheduleIdle(input.modelID);
    }
  }
}
