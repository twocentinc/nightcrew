import { executableSchema } from "./tool.js";
import { z } from "zod";
import { id, uuid, timestamp } from "./common.js";
export const hookSchema = executableSchema.extend({
  hookID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
  purpose: z.enum(["notification", "delivery"]).default("notification"),
  event: z.enum([
    "run.completed",
    "run.failed",
    "run.invalidOutput",
    "run.timedOut",
    "run.cancelled",
    "run.storageLimit",
  ]),
});
export const hookReceiptSchema = z.strictObject({
  receiptID: uuid,
  hookID: id,
  eventID: uuid,
  startedAt: timestamp.nullable(),
  finishedAt: timestamp.nullable(),
  purpose: z.enum(["notification", "delivery"]),
  executablePath: z.string().max(4096),
  status: z.enum(["pending", "started", "succeeded", "failed", "unknown"]),
  diagnostic: z.string().max(2000).nullable(),
});
