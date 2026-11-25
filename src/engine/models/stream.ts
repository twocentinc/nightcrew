import { createParser } from "eventsource-parser";
import { z } from "zod";
import { toolCallSchema } from "../../schemas/common.js";
import type { Result, Runtime } from "./types.js";

export async function readStream(
  response: Response,
  signal: AbortSignal,
  onDelta?: (text: string) => void,
  captureThinking = true,
  onEvidence?: Parameters<Runtime["generate"]>[3],
  continueOnOutputLimit = false,
): Promise<Result> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "",
    reasoningContent = "",
    finish = "";
  let total = 0;
  let ended = false;
  const calls = new Map<
    number,
    { callID: string; name: string; arguments: string }
  >();
  let usage = { inputTokens: 0, outputTokens: 0 };
  const chunkSchema = z.object({
    choices: z.array(
      z.object({
        index: z.number().int(),
        finish_reason: z.string().nullable().optional(),
        delta: z.object({
          content: z.string().nullable().optional(),
          reasoning_content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                index: z.number().int().min(0).max(31),
                id: z.string().optional(),
                function: z
                  .object({
                    name: z.string().optional(),
                    arguments: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .optional(),
        }),
      }),
    ),
    usage: z
      .object({
        prompt_tokens: z.number().nonnegative(),
        completion_tokens: z.number().nonnegative(),
      })
      .nullable()
      .optional(),
  });
  const event = (payload: string) => {
    if (ended) return;
    payload = payload.trim();
    if (payload === "[DONE]") {
      ended = true;
      return;
    }
    const chunk = chunkSchema.parse(JSON.parse(payload));
    if (chunk.usage)
      usage = {
        inputTokens: chunk.usage.prompt_tokens,
        outputTokens: chunk.usage.completion_tokens,
      };
    for (const choice of chunk.choices) {
      if (choice.index !== 0) continue;
      if (choice.finish_reason) finish = choice.finish_reason;
      if (choice.delta.content) {
        text += choice.delta.content;
        onDelta?.(choice.delta.content);
      }
      if (captureThinking && choice.delta.reasoning_content) {
        reasoningContent += choice.delta.reasoning_content;
        if (Buffer.byteLength(reasoningContent) > 1048576) {
          onEvidence?.({
            reasoningContent,
            toolCalls: [...calls.entries()].map(([index, c]) => ({
              index,
              ...c,
            })),
          });
          throw Error("Reasoning output limit");
        }
      }
      for (const part of choice.delta.tool_calls ?? []) {
        const call = calls.get(part.index) ?? {
          callID: "",
          name: "",
          arguments: "",
        };
        if (part.id) call.callID = part.id;
        call.name += part.function?.name ?? "";
        call.arguments += part.function?.arguments ?? "";
        calls.set(part.index, call);
      }
      onEvidence?.({
        reasoningContent,
        toolCalls: [...calls.entries()].map(([index, c]) => ({
          index,
          ...c,
        })),
      });
    }
  };
  const parser = createParser({
    onEvent: ({ data }) => event(data),
    maxBufferSize: 4 * 1024 * 1024,
    onError: (error) => {
      if (error.type === "max-buffer-size-exceeded")
        throw Error("Output limit");
    },
  });
  try {
    while (!ended) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > 4 * 1024 * 1024) throw Error("Output limit");
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
  } finally {
    await reader.cancel();
  }
  if (
    !ended ||
    ![
      "stop",
      "tool_calls",
      ...(continueOnOutputLimit ? ["length"] : []),
    ].includes(finish)
  )
    throw Error("Incomplete generation");
  return {
    ...(finish === "length" ? { outputLimitReached: true } : {}),
    text,
    ...(captureThinking && reasoningContent ? { reasoningContent } : {}),
    // A length-limited tool call may not even contain valid JSON or an ID.
    // Preserve fragments through onEvidence, never expose them for execution.
    toolCalls:
      finish === "length"
        ? []
        : [...calls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, c]) => toolCallSchema.parse(c)),
    usage,
  };
}
