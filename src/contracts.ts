import {
  outputValidationSchema,
  loopPolicySchema,
  validationRecordSchema,
  recoverySchema,
  outcomeSchema,
} from "./supervision.js";
import {
  compactionSchema,
  compactionStateSchema,
  checkpointSchema,
} from "./compaction.js";
import { executionSlots, schedulerSchema } from "./scheduler.js";
import { scheduleSchema } from "./triggers.js";
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
  reasoningContent: z.string().max(1048576).optional(),
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
  compactionThresholdTokens: z
    .number()
    .int()
    .min(1)
    .max(262144)
    .nullable()
    .default(null),
  priority: z.number().int().min(-100).max(100).default(0),
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
  purpose: z.enum(["notification", "delivery"]).default("notification"),
  event: z.enum([
    "run.completed",
    "run.failed",
    "run.timedOut",
    "run.cancelled",
    "run.storageLimit",
  ]),
  executablePath: z.string().max(4096),
  timeoutMs: z.number().int().min(100).max(60000),
});
export const configSchema = z.strictObject({
  scheduler: schedulerSchema.default(() => schedulerSchema.parse({})),
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
  outputValidation: outputValidationSchema.nullable().default(null),
  loopPolicy: loopPolicySchema.default(() => loopPolicySchema.parse({})),
  storageLimitMB: z.number().int().min(1).max(48).default(48),
  compaction: compactionSchema.nullable().default(null),
  contextMode: z.enum(["fresh", "persistent"]).default("fresh"),
  priority: z.number().int().min(-100).max(100).default(0),
  timeSliceMs: z.number().int().min(100).max(3600000).default(60000),
  agentID: id,
  revision: z.number().int().positive().max(2147483647),
  name: z.string().min(1).max(200),
  systemPrompt: z.string().max(64000),
  mode: z.enum(["single-turn", "agent-loop"]),
  modelID: id,
  slotID: id.default("auto"),
  skillIDs: z.array(id).max(40),
  toolIDs: z.array(toolID).max(64),
  thinking: z.boolean().default(true),
  maxToolCalls: z.number().int().min(1).max(1000).optional(),
  temperature: z.number().min(0).max(2).default(0.7),
  sampling: z
    .strictObject({
      topP: z.number().min(0).max(1).optional(),
      topK: z.number().int().min(0).max(1000).optional(),
      minP: z.number().min(0).max(1).optional(),
      presencePenalty: z.number().min(-2).max(2).optional(),
      repeatPenalty: z.number().min(0).max(2).optional(),
      parallelToolCalls: z.boolean().optional(),
    })
    .optional(),
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
export const skillFileSchema = z
  .strictObject({
    path: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) =>
          /^(references|assets)\//.test(value) &&
          value
            .split("/")
            .every((part) => part !== "" && part !== "." && part !== "..") &&
          !/[\\\x00-\x1f]/.test(value),
        "Expected a relative references/ or assets/ file path",
      ),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
    content: z.string().max(180000),
  })
  .superRefine((value, ctx) => {
    const bytes = Buffer.from(
      value.content,
      value.encoding === "base64" ? "base64" : "utf8",
    );
    if (
      bytes.length > 128 * 1024 ||
      (value.encoding === "base64" &&
        bytes.toString("base64") !== value.content)
    )
      ctx.addIssue({
        code: "custom",
        message: "Invalid encoding or file exceeds 128 KB",
      });
  });
export const skillSchema = z
  .strictObject({
    skillID: id,
    name: z.string().max(200),
    description: z.string().max(2000),
    instructions: z.string().max(16000),
    toolIDs: z.array(toolID).max(64),
    files: z.array(skillFileSchema).max(64).default([]),
  })
  .superRefine((value, ctx) => {
    if (
      new Set(value.files.map((f) => f.path)).size !== value.files.length ||
      Buffer.byteLength(JSON.stringify(value.files)) > 512 * 1024
    )
      ctx.addIssue({
        code: "custom",
        message: "Duplicate paths or skill files exceed 512 KB",
      });
  });
export const skillLoadInputSchema = z.strictObject({
  skillIDs: z.array(id).max(40).default([]),
  files: z
    .array(z.strictObject({ skillID: id, path: skillFileSchema.shape.path }))
    .max(4)
    .default([]),
});
export const skillMetadataSchema = z.strictObject({
  skillID: id,
  name: skillSchema.shape.name,
  description: skillSchema.shape.description,
});
export const skillLoadResultSchema = z.strictObject({
  available: z.array(skillMetadataSchema),
  skills: z.array(
    z.strictObject({
      ...skillSchema.shape,
      files: z.array(
        z.strictObject({
          path: z.string(),
          encoding: z.enum(["utf8", "base64"]),
          bytes: z.number().int().nonnegative(),
        }),
      ),
    }),
  ),
  files: z.array(skillFileSchema.safeExtend({ skillID: id })),
});
export const triggerDraftSchema = z.strictObject({
  triggerID: id,
  name: z.string().min(1).max(200),
  agentID: id,
  enabled: z.boolean().default(false),
  schedule: scheduleSchema,
  message: userMessageSchema
    .omit({ messageID: true })
    .default({ content: "", attachments: [] }),
  queuePolicy: z.enum(["skip", "enqueue", "coalesce"]).default("skip"),
});
export const triggerSchema = triggerDraftSchema.extend({
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  anchorAt: timestamp,
});
export const triggerSourceSchema = z.strictObject({
  definition: triggerSchema,
  admission: z.enum(["manual", "timer"]).default("manual"),
  occurrences: z
    .array(
      z.strictObject({
        occurrenceID: uuid,
        inputHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .min(1)
    .max(1000),
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
    "held",
    "released",
    "coalesced",
    "pendingInput",
    "attempt",
    "storageLimit",
    "compactionRequested",
    "compacted",
    "compactionFailed",
    "outputValidation",
    "loopRecovery",
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
export const attemptSchema = z.strictObject({
  attemptID: uuid,
  segment: z.number().int().nonnegative(),
  startedAt: timestamp,
  updatedAt: timestamp,
  status: z.enum([
    "running",
    "completed",
    "failed",
    "interrupted",
    "cancelled",
    "timedOut",
  ]),
  reason: z.string().max(128).nullable(),
  thinking: z.boolean(),
  text: z.string().max(1048576),
  reasoningContent: z.string().max(1048576),
  toolCalls: z
    .array(
      z.strictObject({
        index: z.number().int().min(0).max(31),
        callID: z.string().max(128),
        name: z.string().max(128),
        arguments: z.string().max(64000),
      }),
    )
    .max(32),
  truncated: z.boolean(),
  messageID: uuid.nullable(),
});
export const runSchema = z.strictObject({
  deliveryExpected: z.boolean().default(false),
  validations: z.array(validationRecordSchema).max(10000).default([]),
  recovery: recoverySchema.nullable().default(null),
  attempts: z.array(attemptSchema).max(10000).default([]),
  compactions: z.array(checkpointSchema).max(1000).default([]),
  compaction: compactionStateSchema.nullable().default(null),
  parentRunID: id.nullable().default(null),
  version: z.union([z.literal(1), z.literal(2)]),
  toolSnapshots: z.array(z.json()).max(65).default([]),
  held: z.boolean().default(false),
  interactive: z.boolean().nullable().default(null),
  pendingInputs: z
    .array(
      z.strictObject({
        message: userMessageSchema,
        cancelled: z.boolean().default(false),
        source: triggerSourceSchema.nullable(),
        agent: agentSchema.optional(),
        skills: z.array(skillSchema).optional(),
        tools: z.array(z.json()).optional(),
      }),
    )
    .max(1000)
    .default([]),
  triggerHistory: z.array(triggerSourceSchema).max(1000).default([]),
  triggerSource: triggerSourceSchema.nullable().default(null),
  runID: id,
  revision: z.number().int().positive().max(2147483647),
  createdAt: timestamp,
  updatedAt: timestamp,
  agent: agentSchema,
  skills: z.array(skillSchema).max(40),
  segment: z.number().int().nonnegative().max(2147483647),
  state: runState,
  pauseReason: z
    .enum([
      "presence",
      "cooldown",
      "instant",
      "restart",
      "manualStop",
      "timeSlice",
      "scheduler",
      "compaction",
      "context_full",
      "storage_limit",
    ])
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
        purpose: z.enum(["notification", "delivery"]).default("notification"),
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
  triggers: z.array(triggerSchema).max(1000).default([]),
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
  skillIDs: z.array(id).max(40).default([]),
  conversationID: id,
  modelID: id.optional(),
  slotID: id.default("instant"),
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
  if (
    config.scheduler.instantModelID &&
    !config.models.some(
      (m) => m.modelID === config.scheduler.instantModelID && m.kind === "chat",
    )
  )
    throw new Error("Instant model must reference a configured chat model");
  const triggers = store.triggers ?? [];
  if (
    new Set(triggers.map((t) => t.triggerID)).size !== triggers.length ||
    triggers.some((t) => !agents.some((a) => a.agentID === t.agentID))
  )
    throw new Error("Invalid trigger agent reference or duplicate identity");
  for (const xs of [
    config.models.map((x) => x.modelID),
    config.slots.map((x) => x.slotID),
    agents.map((x) => x.agentID),
  ])
    if (new Set(xs).size !== xs.length) throw new Error("Duplicate identity");
  if (config.slots.length && config.slots.filter((x) => x.instant).length !== 1)
    throw new Error("Configure exactly one instant slot");
  for (const slot of config.slots)
    if (!config.models.some((x) => x.modelID === slot.modelID))
      throw new Error("Unknown slot model");
  for (const model of config.models) {
    if (
      model.compactionThresholdTokens &&
      (model.kind !== "chat" ||
        executionSlots(config).some(
          (s) =>
            s.modelID === model.modelID &&
            model.compactionThresholdTokens! > s.contextTokens,
        ))
    )
      throw Error(
        "Compaction threshold must fit the chat model context capacity",
      );
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
    if (a.compaction?.handler.type === "agent") {
      const handler = a.compaction.handler;
      const compactor = agents.find((c) => c.agentID === handler.agentID);
      if (
        !compactor ||
        compactor.agentID === a.agentID ||
        compactor.mode !== "single-turn" ||
        !config.models.some(
          (m) => m.modelID === compactor.modelID && m.kind === "chat",
        )
      )
        throw Error("Compactor must reference another single-turn chat agent");
    }
    const slot = config.slots.find((x) => x.slotID === a.slotID);
    const model = config.models.find((x) => x.modelID === a.modelID);
    if (
      !model ||
      (a.slotID !== "auto" && (!slot || slot.modelID !== a.modelID))
    )
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
    held: true,
    runID: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
    state: true,
    segment: true,
    activeMs: true,
    pauseReason: true,
  })
  .extend({
    agentID: id,
    remainingMs: z.number().nonnegative(),
    outcome: outcomeSchema,
  });
export const runDetailSchema = runSummarySchema.extend({
  validations: runSchema.shape.validations,
  recovery: runSchema.shape.recovery,
  compactions: runSchema.shape.compactions,
  compaction: runSchema.shape.compaction,
  parentRunID: runSchema.shape.parentRunID,
  agent: agentSchema,
  triggerSource: triggerSourceSchema.nullable(),
  pendingInputs: runSchema.shape.pendingInputs,
  skills: z.array(skillSchema),
  result: runSchema.shape.result,
  error: runSchema.shape.error,
  hookReceipts: z.array(
    runSchema.shape.hookReceipts.element.omit({ executablePath: true }),
  ),
});
export const transcriptEntrySchema = eventSchema.extend({
  attempt: attemptSchema.nullable().default(null),
  message: messageSchema.nullable(),
});
export const resultSchema = z.object({
  text: z.string(),
  reasoningContent: z.string().max(1048576).optional(),
  toolCalls: z.array(toolCallSchema),
  usage: z.object({
    inputTokens: z.number().nonnegative(),
    outputTokens: z.number().nonnegative(),
  }),
});
export const chatDetailSchema = z.object({
  requestID: id,
  conversationID: id,
  modelID: id.optional(),
  state: z.string(),
  createdAt: timestamp,
  updatedAt: timestamp,
  messages: z.array(messageSchema).default([]),
  result: resultSchema.nullable(),
  error: runSchema.shape.error,
});
export const toolSchema = z.object({
  toolID: id,
  description: z.string(),
  parameters: z.record(z.string(), z.json()),
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
