import { gradeSchema } from "../engine/evals/format.js";
import { z } from "zod";
import { id, messageSchema, resultSchema, timestamp, uuid } from "./common.js";
import { pauseReasonSchema, storageLimitSchema } from "./execution.js";
const empty = z.strictObject({});
const message = z.union([
  z.strictObject({ messageID: uuid }),
  z.strictObject({ message: messageSchema }),
]);
const reason = z.string().max(2000);
const count = z.number().int().nonnegative();
const generation = z.strictObject({
  ...resultSchema.shape,
  outputLimitReached: z.boolean().optional(),
});
export const eventPayloads = {
  evalGraded: gradeSchema,
  toolStarted: z.strictObject({ callID: id, name: z.string() }),
  queued: z.strictObject({ parentRunID: id.optional() }),
  started: empty,
  paused: z.strictObject({
    reason: pauseReasonSchema.optional(),
    childRunID: id.optional(),
    code: z.string().optional(),
    message: reason.optional(),
  }),
  resumed: empty,
  message,
  toolResult: message,
  completed: z.union([empty, z.strictObject({ messageID: uuid }), generation]),
  invalidOutput: empty,
  failed: empty,
  cancelled: empty,
  timedOut: empty,
  interrupted: empty,
  hookResult: z.strictObject({
    receiptID: uuid.nullable(),
    sourceEventID: uuid,
    status: z.enum(["succeeded", "failed", "unknown"]),
  }),
  held: empty,
  released: z.strictObject({ parentRunID: id.optional() }),
  coalesced: z.strictObject({ messageID: uuid }),
  pendingInput: z.strictObject({ messageID: uuid }),
  attempt: z.strictObject({ attemptID: uuid }),
  storageLimit: z.strictObject({
    previousState: z.string(),
    limit: storageLimitSchema,
  }),
  compactionRequested: z.union([
    z.strictObject({
      requestID: uuid,
      coveredThrough: count,
      inputTokens: count,
    }),
    z.strictObject({
      partitioned: z.literal(true),
      childRunID: id,
      coveredThrough: count,
      inputTokens: count,
    }),
  ]),
  compacted: z.strictObject({
    checkpointID: uuid,
    warnings: z.array(z.string()),
    coveredThrough: count,
    inputTokens: count,
    outputTokens: count,
    childRunID: id.nullable(),
  }),
  compactionFailed: z.strictObject({ message: reason }),
  outputValidation: z.strictObject({
    messageID: uuid,
    status: z.enum(["passed", "failed", "error"]),
    reason,
  }),
  toolLoopUpdated: z.strictObject({ reason, finalizing: z.boolean() }),
  retried: z.strictObject({
    previousTurnID: uuid,
    messageID: uuid,
    note: reason,
  }),
  compactionRetry: z.strictObject({
    message: reason,
    requestID: uuid,
    childRunID: id.nullable(),
    targetTokens: count,
    attempt: count,
  }),
};
const envelope = {
  eventID: uuid,
  sequence: z.number().int().positive().max(2147483647),
  at: timestamp,
  turnID: uuid,
};
export const eventSchema = z.discriminatedUnion(
  "type",
  Object.entries(eventPayloads).map(([type, data]) =>
    z.strictObject({ ...envelope, type: z.literal(type), data }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<Event>;
export type EventType = keyof typeof eventPayloads;
// Preserve the correlation in the type as well as runtime validation.
export type Event = {
  [K in EventType]: z.infer<z.ZodObject<typeof envelope>> & {
    type: K;
    data: z.infer<(typeof eventPayloads)[K]>;
  };
}[EventType];
