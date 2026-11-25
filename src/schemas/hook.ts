import { z } from "zod";
import { id, uuid, timestamp } from "./common.js";
export const hookSchema = z.strictObject({
  hookID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
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
export const hookReceiptSchema = z.strictObject({
  receiptID: uuid,
  hookID: id,
  eventID: uuid,
  retryOfReceiptID: uuid.nullable(),
  requestID: uuid.nullable(),
  note: z.string().max(2000).nullable(),
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  purpose: z.enum(["notification", "delivery"]),
  executablePath: z.string().max(4096),
  status: z.enum(["pending", "started", "succeeded", "failed", "unknown"]),
  diagnostic: z.string().max(2000).nullable(),
});
