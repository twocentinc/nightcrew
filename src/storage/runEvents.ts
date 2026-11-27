import { z } from "zod";
import { eventSchema, eventPayloads, type Event } from "../schemas/event.js";
import {
  messageSchema,
  userMessageSchema,
  uuid,
  timestamp,
} from "../schemas/common.js";
import { runProjectionSchema } from "../schemas/run.js";

const fields = runProjectionSchema.shape;
export const configurationSchema = z.strictObject({
  agent: fields.agent,
  skills: fields.skills,
  tools: fields.toolSnapshots,
});
const queuedSchema = z.strictObject({
  messageID: uuid,
  source: fields.triggerSource,
  cancelled: z.boolean(),
  configuration: configurationSchema.nullable(),
});
export const scalarEvents = {
  interactive: "turnPriorityChanged",
  parentRunID: "parentLinked",
  triggerSource: "triggerSubmitted",
  contextUsage: "contextMeasured",
  toolLoop: "toolLoopLimited",
  deliveryExpected: "deliveryExpected",
  evaluation: "evalStateChanged",
  compaction: "compactionChanged",
} as const;
export const collectionEvents = {
  attempts: { key: "attemptID", event: "generationCheckpointed" },
  compactions: { key: "checkpointID", event: "compactionCommitted" },
  hookReceipts: { key: "receiptID", event: "hookInvocationChanged" },
  validations: { key: "messageID", event: "outputValidated" },
  capabilityRefreshes: { key: "at", event: "capabilitiesRefreshed" },
} as const;
const scalar = <T extends z.ZodType>(value: T) => z.strictObject({ value });
const collection = <T extends z.ZodType>(value: T) =>
  z.strictObject({ value });
const payloads = {
  configurationChanged: z.strictObject({
    configurationID: z.string(),
    configuration: configurationSchema,
  }),
  messageRecorded: z.strictObject({ messageID: uuid }),
  turnQueued: queuedSchema,
  turnDequeued: z.strictObject({ messageID: uuid }),
  triggerHistoryRecorded: z.strictObject({
    source: fields.triggerHistory.unwrap().element,
  }),
  turnPriorityChanged: scalar(fields.interactive),
  parentLinked: scalar(fields.parentRunID),
  triggerSubmitted: scalar(fields.triggerSource),
  contextMeasured: scalar(fields.contextUsage),
  toolLoopLimited: scalar(fields.toolLoop),
  deliveryExpected: scalar(fields.deliveryExpected),
  evalStateChanged: scalar(fields.evaluation.unwrap().nullable()),
  compactionChanged: scalar(fields.compaction),
  generationCheckpointed: collection(fields.attempts.unwrap().element),
  compactionCommitted: collection(fields.compactions.unwrap().element),
  hookInvocationChanged: collection(fields.hookReceipts.element),
  outputValidated: collection(fields.validations.unwrap().element),
  capabilitiesRefreshed: collection(
    fields.capabilityRefreshes.unwrap().element,
  ),
};
const envelope = {
  eventID: uuid,
  sequence: z.number().int().positive(),
  at: timestamp,
  turnID: uuid,
};
type RecordedEvent = {
  [K in keyof typeof payloads]: z.infer<z.ZodObject<typeof envelope>> & {
    type: K;
    data: z.infer<(typeof payloads)[K]>;
  };
}[keyof typeof payloads];
const recordedEventSchema = z.discriminatedUnion(
  "type",
  Object.entries(payloads).map(([type, data]) =>
    z.strictObject({ ...envelope, type: z.literal(type), data }),
  ) as unknown as [z.ZodObject, ...z.ZodObject[]],
) as unknown as z.ZodType<RecordedEvent>;
export const documentEventSchema = z.union([eventSchema, recordedEventSchema]);
export type DocumentEvent = z.infer<typeof documentEventSchema>;
export const isLifecycleEvent = (event: DocumentEvent): event is Event =>
  Object.hasOwn(eventPayloads, event.type);
export const documentMessageSchema = z.union([
  messageSchema.safeExtend({ turnID: uuid }),
  userMessageSchema.extend({ turnID: uuid }),
]);
export type QueuedTurn = z.infer<typeof queuedSchema>;
export type Configuration = z.infer<typeof configurationSchema>;
