import { z } from "zod";
import {
  checkpointSchema,
  compactionStateSchema,
} from "../engine/compaction/format.js";
import {
  outcomeSchema,
  recoverySchema,
  reviewRecordSchema,
  validationRecordSchema,
} from "../engine/supervision.js";
import { agentSchema, skillSchema, triggerSourceSchema } from "./agent.js";
import {
  id,
  messageSchema,
  runErrorSchema,
  timestamp,
  userMessageSchema,
  uuid,
} from "./common.js";
import { slotSchema } from "./model.js";

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
    "notification",
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
    "reviewed",
    "retried",
    "compactionRetry",
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
export const contextUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  capacityTokens: z.number().int().positive(),
  measuredAt: timestamp,
  segment: z.number().int().nonnegative(),
});
export const runSchema = z.strictObject({
  capabilityRefreshes: z
    .array(
      z.strictObject({
        at: timestamp,
        segment: z.number().int().nonnegative(),
        sourceAgentRevision: z.number().int().positive(),
        previousToolIDs: z.array(id),
        previousSkillIDs: z.array(id),
        previousTools: z.array(z.json()),
        previousSkills: z.array(skillSchema),
      }),
    )
    .max(100)
    .default([]),
  contextUsage: contextUsageSchema.nullable().default(null),
  reviews: z.array(reviewRecordSchema).max(1000).default([]),
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
      "runtime_error",
      "storage_limit",
    ])
    .nullable(),
  activeMs: z.number().int().min(0).max(86400000),
  messages: z.array(messageSchema).max(10000),
  events: z.array(eventSchema).max(20000),
  result: z.string().max(1048576).nullable(),
  error: runErrorSchema,
  hookReceipts: z
    .array(
      z.strictObject({
        requestID: z.uuid().nullable().default(null),
        retryOf: z.number().int().nonnegative().nullable().default(null),
        note: z.string().max(2000).nullable().default(null),
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
export type Run = z.infer<typeof runSchema>;
export type Event = z.infer<typeof eventSchema>;
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
  capabilityRefreshes: runSchema.shape.capabilityRefreshes,
  contextUsage: runSchema.shape.contextUsage,
  reviews: runSchema.shape.reviews,
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
