import { loggingSchema } from "./logging.js";
import { z } from "zod";

export const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/);
export const uuid = z.uuid().toLowerCase();
const timestamp = z.iso.datetime();
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
  attachments: z.array(attachmentSchema).max(16),
});
export const toolCallSchema = z.strictObject({
  callID: id,
  name: z.string().max(128),
  arguments: z.string().max(64000),
});
export const messageSchema = z.strictObject({
  messageID: uuid,
  thinking: z.boolean().optional(),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string().max(1048576),
  attachments: z.array(attachmentSchema).max(16),
  toolCalls: z.array(toolCallSchema).max(32),
  toolCallID: id.nullable(),
});
export const slotSchema = z.strictObject({
  slotID: id,
  modelID: id,
  index: z.number().int().min(0).max(31),
  contextTokens: z.number().int().min(1024).max(262144),
  instant: z.boolean(),
});
export const modelSchema = z.strictObject({
  modelID: id,
  kind: z.enum(["chat", "audio"]),
  weightsPath: z.string().max(4096),
  projectorPath: z.string().max(4096).nullable(),
  idleUnloadMs: z.number().int().min(0).max(86400000),
  slotSnapshots: z
    .strictObject({
      enabled: z.boolean().default(false),
      directory: z
        .string()
        .max(4096)
        .regex(/^\/[^\r\n]*$/)
        .nullable()
        .default(null),
    })
    .default({ enabled: false, directory: null }),
});
export const hookSchema = z.strictObject({
  event: z.enum([
    "run.completed",
    "run.failed",
    "run.timedOut",
    "run.cancelled",
  ]),
  executablePath: z.string().max(4096),
  timeoutMs: z.number().int().min(100).max(60000),
});
export const configSchema = z.strictObject({
  revision: z.number().int().positive().max(2147483647),
  host: z.enum(["127.0.0.1", "::1"]),
  port: z.number().int().min(1024).max(65535),
  interactionCooldownMs: z.number().int().min(0).max(3600000),
  logging: loggingSchema.default({
    level: "warn",
    maxBytes: 1048576,
    files: 3,
  }),
  rootTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  models: z.array(modelSchema).max(32),
  slots: z.array(slotSchema).max(32),
  hooks: z.array(hookSchema).max(16),
});
export const agentSchema = z.strictObject({
  agentID: id,
  revision: z.number().int().positive().max(2147483647),
  name: z.string().min(1).max(200),
  systemPrompt: z.string().max(64000),
  mode: z.enum(["single-turn", "agent-loop"]),
  modelID: id,
  slotID: id,
  skillIDs: z.array(id).max(40),
  toolIDs: z.array(toolID).max(64),
  thinking: z.boolean().default(true),
  temperature: z.number().min(0).max(2).default(0.7),
  maxOutputTokens: z.number().int().min(1).max(32768).default(4096),
  timeoutMs: z.number().int().min(1000).max(86400000),
  enabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const agentDraftSchema = agentSchema
  .omit({ revision: true, createdAt: true, updatedAt: true })
  .extend({
    timeoutMs: z.number().int().min(1000).max(86400000).default(1800000),
  });
export const skillSchema = z.strictObject({
  skillID: id,
  name: z.string().max(200),
  description: z.string().max(2000),
  instructions: z.string().max(16000),
  toolIDs: z.array(toolID).max(64),
});
export const eventSchema = z.strictObject({
  sequence: z.number().int().positive().max(2147483647),
  at: timestamp,
  type: z.enum([
    "queued",
    "started",
    "paused",
    "resumed",
    "message",
    "toolResult",
    "completed",
    "failed",
    "cancelled",
    "timedOut",
    "interrupted",
    "hookResult",
  ]),
  segment: z.number().int().nonnegative(),
  data: z.json(),
});
export const runState = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "failed",
  "cancelled",
  "timedOut",
]);
export const runSchema = z.strictObject({
  version: z.union([z.literal(1), z.literal(2)]),
  toolSnapshots: z.array(z.json()).max(64).default([]),
  runID: id,
  revision: z.number().int().positive().max(2147483647),
  createdAt: timestamp,
  updatedAt: timestamp,
  agent: agentSchema,
  skills: z.array(skillSchema).max(40),
  segment: z.number().int().nonnegative().max(2147483647),
  state: runState,
  pauseReason: z
    .enum(["presence", "cooldown", "instant", "restart", "manualStop"])
    .nullable(),
  activeMs: z.number().int().min(0).max(86400000),
  messages: z.array(messageSchema).max(10000),
  events: z.array(eventSchema).max(20000),
  result: z.string().max(1048576).nullable(),
  error: z
    .strictObject({ code: z.string().max(128), message: z.string().max(2000) })
    .nullable(),
  hookReceipts: z
    .array(
      z.strictObject({
        eventSequence: z.number().int().positive().max(2147483647),
        executablePath: z.string().max(4096),
        status: z.enum([
          "pending",
          "started",
          "succeeded",
          "failed",
          "unknown",
        ]),
        diagnostic: z.string().max(2000).nullable(),
      }),
    )
    .max(1000),
});
export const storeSchema = z.strictObject({
  version: z.literal(2),
  config: configSchema,
  agents: z.array(agentSchema).max(1000),
  cooldownUntil: timestamp.nullable(),
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
export const chatInputSchema = z.strictObject({
  conversationID: id,
  modelID: id,
  slotID: id,
  messages: z.array(messageSchema).min(1).max(1000),
  tools: z.array(functionToolSchema).max(64).default([]),
  timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  maxOutputTokens: z.number().int().min(1).max(32768).default(4096),
  temperature: z.number().min(0).max(2).default(0.7),
});
export type Agent = z.infer<typeof agentSchema>;
export type Config = z.infer<typeof configSchema>;
export type Store = z.infer<typeof storeSchema>;
export type Run = z.infer<typeof runSchema>;
export type Message = z.infer<typeof messageSchema>;
export type UserMessage = z.infer<typeof userMessageSchema>;
export type Skill = z.infer<typeof skillSchema>;
export type ChatInput = z.infer<typeof chatInputSchema>;
export type Event = z.infer<typeof eventSchema>;
export const terminal = (state: string) =>
  ["completed", "failed", "cancelled", "timedOut", "interrupted"].includes(
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
export function validateConfig(store: Store) {
  const { config, agents } = store;
  for (const xs of [
    config.models.map((x) => x.modelID),
    config.slots.map((x) => x.slotID),
    agents.map((x) => x.agentID),
  ])
    if (new Set(xs).size !== xs.length) throw new Error("Duplicate identity");
  if (
    config.models.length &&
    config.slots.filter((x) => x.instant).length !== 1
  )
    throw new Error("Configure exactly one instant slot");
  for (const slot of config.slots)
    if (!config.models.some((x) => x.modelID === slot.modelID))
      throw new Error("Unknown slot model");
  for (const model of config.models) {
    const slots = config.slots
      .filter((x) => x.modelID === model.modelID)
      .sort((a, b) => a.index - b.index);
    if (
      slots.some(
        (s, i) => s.index !== i || s.contextTokens !== slots[0]?.contextTokens,
      )
    )
      throw new Error(
        "Slot indices must be contiguous with equal context capacity",
      );
  }
  for (const a of agents) {
    const slot = config.slots.find((x) => x.slotID === a.slotID);
    const model = config.models.find((x) => x.modelID === a.modelID);
    if (!slot || !model || slot.modelID !== a.modelID)
      throw new Error("Invalid agent model or slot");
    if (a.mode === "single-turn" && (a.toolIDs.length || a.skillIDs.length))
      throw new Error("Single-turn agents do not use tools or skills");
    if (model.kind === "audio" && a.mode !== "single-turn")
      throw new Error("Audio agents must be single-turn");
    if (
      new Set(a.toolIDs).size !== a.toolIDs.length ||
      new Set(a.skillIDs).size !== a.skillIDs.length
    )
      throw new Error("Duplicate capability");
  }
}

export const publicConfigSchema = configSchema
  .omit({ rootTokenHash: true, models: true, hooks: true })
  .extend({
    models: z.array(
      modelSchema.omit({ weightsPath: true, projectorPath: true }),
    ),
    hooks: z.array(hookSchema.omit({ executablePath: true })),
  });
export const runSummarySchema = runSchema
  .pick({
    runID: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
    state: true,
    segment: true,
    activeMs: true,
    pauseReason: true,
  })
  .extend({ agentID: id, remainingMs: z.number().nonnegative() });
export const runDetailSchema = runSummarySchema.extend({
  agent: agentSchema,
  skills: z.array(skillSchema),
  result: runSchema.shape.result,
  error: runSchema.shape.error,
  hookReceipts: z.array(
    runSchema.shape.hookReceipts.element.omit({ executablePath: true }),
  ),
});
export const transcriptEntrySchema = eventSchema.extend({
  message: messageSchema.nullable(),
});
export const resultSchema = z.object({
  text: z.string(),
  toolCalls: z.array(toolCallSchema),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
  }),
});
export const chatDetailSchema = z.object({
  requestID: id,
  conversationID: id,
  modelID: id,
  state: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  result: resultSchema.nullable(),
  error: runSchema.shape.error,
});
export const toolSchema = z.object({
  toolID: id,
  description: z.string(),
  parameters: z.record(z.string(), z.json()),
  readOnly: z.boolean(),
});
export const statusSchema = z.object({
  presence: z.object({
    state: z.enum(["present", "away"]),
    reason: z.string(),
    samplingHealthy: z.boolean(),
    observedAt: timestamp,
    diagnostic: z.string().nullable(),
  }),
  cooldownUntil: timestamp.nullable(),
  activeRunID: id.nullable(),
  queue: z.array(
    z.object({
      resourceID: id,
      kind: z.string(),
      state: z.string(),
      blockingReason: z.string().nullable(),
    }),
  ),
  models: z.array(z.object({ modelID: id, state: z.string() })),
  slots: z.array(
    slotSchema.extend({ busy: z.boolean(), conversationID: id.nullable() }),
  ),
});
export const streamEventSchema = z.object({
  eventID: z.number().int().nonnegative(),
  type: z.string(),
  at: timestamp,
  resourceID: id,
  segment: z.number().int().nonnegative().max(2147483647),
  data: z.json(),
});
export const searchMatchSchema = z.object({
  runID: id,
  eventSequence: z.number().int(),
  segment: z.number().int(),
  excerpt: z.string().max(1000),
  matchOffset: z.number().int().nonnegative(),
});
export const acceptanceSchema = z.object({
  runID: id,
  status: z.string(),
  eventsURL: z.string(),
  replayed: z.boolean(),
});
export const chatAcceptanceSchema = acceptanceSchema
  .omit({ runID: true })
  .extend({ requestID: id });
export const pageOutput = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });
