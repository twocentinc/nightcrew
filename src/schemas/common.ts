import { z } from "zod";

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const uuid = z.uuid().toLowerCase();
export const timestamp = z.iso.datetime();
export const toolID = id;
export const attachmentSchema = z.strictObject({
  name: z.string().min(1).max(255),
  mediaType: z.enum(["text/plain", "application/json", "audio/wav"]),
  dataBase64: z.string().max(12_000_000),
});
export const userMessageSchema = z.strictObject({
  messageID: uuid,
  thinking: z.boolean().optional(),
  content: z.string().max(262144),
  attachments: z.array(attachmentSchema).max(16).default([]),
});
export const toolCallSchema = z.strictObject({
  callID: id,
  name: z.string().max(128),
  arguments: z.string().max(64000),
});
export const messageSchema = z.strictObject({
  messageID: uuid,
  thinking: z.boolean().optional(),
  reasoningContent: z.string().max(1048576).optional(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(1048576),
  attachments: z.array(attachmentSchema).max(16).default([]),
  toolCalls: z.array(toolCallSchema).max(32).default([]),
  toolCallID: id.nullable().default(null),
}).superRefine((message, ctx) => {
  if (message.role !== "user" && message.attachments.length)
    ctx.addIssue({code: "custom", path: ["attachments"], message: "Only user messages may carry attachments"});
  if (message.role !== "assistant" && message.toolCalls.length)
    ctx.addIssue({code: "custom", path: ["toolCalls"], message: "Only assistant messages may call tools"});
  if (message.role === "tool" ? !message.toolCallID : message.toolCallID !== null)
    ctx.addIssue({code: "custom", path: ["toolCallID"], message: "Only tool results must reference a tool call"});
});
export const pageSchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(512).optional(),
});
export const functionToolSchema = z.strictObject({
  name: z.string().min(1).max(128),
  description: z.string().max(2000),
  parameters: z.record(z.string(), z.json()),
});
export const samplingSchema = z.strictObject({
  temperature: z.number().min(0).max(2).default(0.7),
  topP: z.number().min(0).max(1).optional(),
  topK: z.number().int().min(0).max(1000).optional(),
  minP: z.number().min(0).max(1).optional(),
  presencePenalty: z.number().min(-2).max(2).optional(),
  repeatPenalty: z.number().min(0).max(2).optional(),
});
export const chatInputSchema = z.strictObject({
  skillIDs: z.array(id).max(40).default([]),
  conversationID: id,
  modelID: id.optional(),
  messages: z.array(messageSchema).min(1).max(1000),
  tools: z.array(functionToolSchema).max(64).default([]),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  maxOutputTokens: z.number().int().min(1).max(32768).default(4096),
  sampling: samplingSchema.default(() => samplingSchema.parse({})),
  parallelToolCalls: z.boolean().optional(),
});
export type Message = z.infer<typeof messageSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type ChatInput = z.infer<typeof chatInputSchema>;
export const terminal = (state: string) =>
  ["completed", "invalidOutput", "failed", "cancelled", "timedOut", "interrupted"].includes(
    state,
  );
export const now = () => new Date().toISOString();
export function validateAttachments(
  messages: Pick<Message, "content" | "attachments" | "role">[],
  kind: "chat" | "audio",
) {
  for (const m of messages) {
    let bytes = 0;
    for (const a of m.attachments) {
      if (m.role !== "user")
        throw new Error("Only user messages may carry attachments");
      const data = Buffer.from(a.dataBase64, "base64");
      if (data.toString("base64") !== a.dataBase64)
        throw new Error("Non-canonical base64");
      bytes += data.length;
      if (a.mediaType === "audio/wav") {
        if (
          kind !== "audio" ||
          data.length < 44 ||
          data.toString("ascii", 0, 4) !== "RIFF" ||
          data.toString("ascii", 8, 12) !== "WAVE"
        )
          throw new Error("Unsupported audio input");
        if (data.readUInt32LE(4) + 8 !== data.length)
          throw new Error("Invalid WAV length");
        let fmt = false,
          pcm = false;
        for (let offset = 12; offset + 8 <= data.length; ) {
          const name = data.toString("ascii", offset, offset + 4);
          const size = data.readUInt32LE(offset + 4);
          const end = offset + 8 + size;
          if (end > data.length) throw new Error("Invalid WAV chunk");
          if (name === "fmt ") {
            if (
              size < 16 ||
              data.readUInt16LE(offset + 8) !== 1 ||
              ![1, 2].includes(data.readUInt16LE(offset + 10)) ||
              ![8, 16, 24, 32].includes(data.readUInt16LE(offset + 22))
            )
              throw new Error("PCM WAV required");
            fmt = true;
          }
          if (name === "data" && size > 0) pcm = true;
          offset = end + (size % 2);
        }
        if (!fmt || !pcm) throw new Error("PCM WAV required");
      } else {
        if (kind === "audio") throw new Error("Audio turns accept only WAV");
        const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
        if (a.mediaType === "application/json") {
          const value: unknown = JSON.parse(text);
          const depth = (v: unknown, n = 0): void => {
            if (n > 20) throw new Error("JSON attachment exceeds depth limit");
            if (v && typeof v === "object")
              for (const x of Object.values(v)) depth(x, n + 1);
          };
          depth(value);
        }
      }
    }
    if (bytes > 8 * 1024 * 1024) throw new Error("Attachments exceed 8 MB");
  }
  if (
    kind === "audio" &&
    (messages.at(-1)?.attachments.length !== 1 ||
      messages.at(-1)?.attachments[0]?.mediaType !== "audio/wav")
  )
    throw new Error("Audio turn requires exactly one WAV attachment");
}
export const resultSchema = z.object({
  text: z.string(),
  reasoningContent: z.string().max(1048576).optional(),
  toolCalls: z.array(toolCallSchema),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
  }),
});
export const runErrorSchema = z
  .strictObject({ code: z.string().max(128), message: z.string().max(2000) })
  .nullable();
export const chatDetailSchema = z.object({
  requestID: id,
  conversationID: id,
  modelID: id.optional(),
  state: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  messages: z.array(messageSchema).default([]),
  result: resultSchema.nullable(),
  error: runErrorSchema,
});
export const toolSchema = z.object({
  toolID: id,
  description: z.string(),
  parameters: z.record(z.string(), z.json()),
});
export const streamEventSchema = z.object({
  eventID: z.number().int().nonnegative(),
  type: z.string(),
  at: timestamp,
  resourceID: id,
  turnID: z.string().uuid().nullable(),
  data: z.json(),
});
export const pageOutput = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const revision = z.number().int().positive();
