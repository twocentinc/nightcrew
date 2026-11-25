import { z } from "zod";
import { id } from "./common.js";

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
