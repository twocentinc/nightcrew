import { evalRunStateSchema } from "../engine/evals/format.js";
import { eventSchema } from "./event.js";
import {
  executionSchema,
  executionRecord,
  workingExecution,
  type WorkingExecution,
} from "./execution.js";
import { toolDefinitionSchema } from "./tool.js";
import { hookReceiptSchema } from "./hook.js";
import { z } from "zod";
import {
  checkpointSchema,
  compactionStateSchema,
} from "../engine/compaction/format.js";
import {
  outcomeSchema,
  toolLoopSchema,
  validationRecordSchema,
} from "../engine/supervision.js";
import { agentSchema, skillSchema, triggerSourceSchema } from "./agent.js";
import {
  id,
  messageSchema,
  timestamp,
  userMessageSchema,
  uuid,
} from "./common.js";
import { slotSchema } from "./model.js";

export const runState = z.enum([
  "queued",
  "running",
  "paused",
  "completed",
  "invalidOutput",
  "failed",
  "cancelled",
  "timedOut",
]);
export const attemptSchema = z.strictObject({
  attemptID: uuid,
  turnID: z.string().uuid(),
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
  turnID: z.string().uuid(),
});
export const runProjectionSchema = z.strictObject({
  evaluation: evalRunStateSchema.optional(),
  capabilityRefreshes: z
    .array(
      z.strictObject({
        at: timestamp,
        turnID: z.string().uuid(),
        sourceAgentRevision: z.number().int().positive(),
      }),
    )
    .max(100)
    .default([]),
  contextUsage: contextUsageSchema.nullable().default(null),
  deliveryExpected: z.boolean().default(false),
  validations: z.array(validationRecordSchema).max(10000).default([]),
  toolLoop: toolLoopSchema.nullable().default(null),
  attempts: z.array(attemptSchema).max(10000).default([]),
  compactions: z.array(checkpointSchema).max(1000).default([]),
  compaction: compactionStateSchema.nullable().default(null),
  parentRunID: id.nullable().default(null),
  version: z.literal(4),
  toolSnapshots: z.array(toolDefinitionSchema).max(65).default([]),
  interactive: z.boolean().nullable().default(null),
  pendingInputs: z
    .array(
      z.strictObject({
        message: userMessageSchema,
        cancelled: z.boolean().default(false),
        source: triggerSourceSchema.nullable(),
        agent: agentSchema.optional(),
        skills: z.array(skillSchema).optional(),
        tools: z.array(toolDefinitionSchema).optional(),
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
  turnID: z.string().uuid(),
  execution: executionSchema,
  activeMs: z.number().int().min(0).max(86400000),
  messages: z.array(messageSchema).max(10000),
  events: z.array(eventSchema).max(20000),
  result: z.string().max(1048576).nullable(),
  hookReceipts: z.array(hookReceiptSchema).max(1000),
});
export type StoredRun = z.infer<typeof runProjectionSchema>;
export type Run = Omit<StoredRun, "execution"> & WorkingExecution;
export function encodeRun(run: Run): StoredRun {
  const { state, held, pauseReason, error, storageLimit, ...record } = run;
  const stored = runProjectionSchema.parse({
    ...record,
    execution: executionRecord(run),
  });
  validateRunLinks(stored);
  return stored;
}
export function decodeRun(record: StoredRun): Run {
  validateRunLinks(record);
  const { execution, ...rest } = record;
  return { ...rest, ...workingExecution(execution) };
}
export const runSummarySchema = runProjectionSchema
  .pick({
    runID: true,
    revision: true,
    createdAt: true,
    updatedAt: true,
    execution: true,
    turnID: true,
    activeMs: true,
  })
  .extend({
    agentID: id,
    remainingMs: z.number().nonnegative(),
    outcome: outcomeSchema,
  });
export const runDetailSchema = runSummarySchema.extend({
  evaluation: evalRunStateSchema.optional(),
  capabilityRefreshes: runProjectionSchema.shape.capabilityRefreshes,
  contextUsage: runProjectionSchema.shape.contextUsage,
  validations: runProjectionSchema.shape.validations,
  toolLoop: runProjectionSchema.shape.toolLoop,
  compactions: runProjectionSchema.shape.compactions,
  compaction: runProjectionSchema.shape.compaction,
  parentRunID: runProjectionSchema.shape.parentRunID,
  agent: agentSchema,
  triggerSource: triggerSourceSchema.nullable(),
  pendingInputs: runProjectionSchema.shape.pendingInputs,
  skills: z.array(skillSchema),
  result: runProjectionSchema.shape.result,
  hookReceipts: z.array(
    runProjectionSchema.shape.hookReceipts.element.omit({
      executablePath: true,
    }),
  ),
});
export const transcriptEntrySchema = eventSchema.and(
  z.object({
    attempt: attemptSchema.nullable().default(null),
    message: messageSchema.nullable(),
  }),
);
export const statusSchema = z.object({
  presence: z.object({
    state: z.enum(["present", "away"]),
    reason: z.string(),
    samplingHealthy: z.boolean(),
    observedAt: timestamp,
    diagnostic: z.string().nullable(),
  }),
  cooldownUntil: timestamp.nullable(),
  active: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["run", "chat"]),
      slotID: z.string(),
      modelID: z.string(),
    }),
  ),
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
  turnID: z.string().uuid(),
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

/** Identity links are checked on both reads and commits, within the storage transaction. */
function validateRunLinks(run: StoredRun) {
  const events = new Map(run.events.map((e) => [e.eventID, e]));
  const receipts = new Map(run.hookReceipts.map((r) => [r.receiptID, r]));
  if (
    events.size !== run.events.length ||
    receipts.size !== run.hookReceipts.length
  )
    throw Error("Duplicate event or receipt identity");
  for (const receipt of run.hookReceipts) {
    if (!events.has(receipt.eventID))
      throw Error("Missing hook event reference");
    if (
      receipt.startedAt &&
      receipt.finishedAt &&
      receipt.finishedAt < receipt.startedAt
    )
      throw Error("Invalid hook receipt timestamps");
    if (["pending", "started"].includes(receipt.status) && receipt.finishedAt)
      throw Error("Unsettled hook has a finish timestamp");
    if (receipt.status === "pending" && receipt.startedAt)
      throw Error("Pending hook has a start timestamp");
  }
  for (const e of run.events)
    if (e.type === "hookResult") {
      if (!events.has(e.data.sourceEventID))
        throw Error("Missing hook result source event");
      if (
        e.data.receiptID &&
        receipts.get(e.data.receiptID)?.eventID !== e.data.sourceEventID
      )
        throw Error("Invalid hook result receipt reference");
    }
}

/** Metadata stored alongside messages and events in the single run document. */
export const runStateRecordSchema = z.strictObject({
  version: z.literal(10),
  runID: id,
  revision: z.number().int().positive(),
  createdAt: timestamp,
  updatedAt: timestamp,
  turnID: uuid,
  execution: executionSchema,
  activeMs: z.number().int().nonnegative(),
});
export type RunStateRecord = z.infer<typeof runStateRecordSchema>;

/** Integrity rules shared by persisted reads and exported-bundle verification. */
export function validateTranscript(
  run: Pick<StoredRun, "messages" | "pendingInputs" | "events">,
) {
  const ids = [...run.messages, ...run.pendingInputs.map((p) => p.message)].map(
    (m) => m.messageID,
  );
  if (new Set(ids).size !== ids.length)
    throw Error("Duplicate transcript message");
  if (run.events.some((event, index) => event.sequence !== index + 1))
    throw Error("Invalid event order");
  const calls = new Set<string>(),
    results = new Set<string>();
  for (const message of run.messages) {
    if (message.attachments.length && message.role !== "user")
      throw Error("Invalid attachments");
    if (message.toolCalls.length && message.role !== "assistant")
      throw Error("Invalid tool calls");
    for (const call of message.toolCalls) {
      if (calls.has(call.callID)) throw Error("Duplicate tool call");
      calls.add(call.callID);
    }
    if (message.role === "tool") {
      if (
        !message.toolCallID ||
        !calls.has(message.toolCallID) ||
        results.has(message.toolCallID)
      )
        throw Error("Invalid tool result reference");
      results.add(message.toolCallID);
    } else if (message.toolCallID) throw Error("Invalid tool result reference");
  }
}
