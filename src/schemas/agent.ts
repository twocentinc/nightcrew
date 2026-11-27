import { z } from "zod";
import { compactionSchema } from "../engine/compaction/format.js";
import { scheduleSchema } from "../engine/scheduling/schedule.js";
import { loopPolicySchema } from "../engine/supervision.js";
import {
  samplingSchema,
  id,
  timestamp,
  toolID,
  userMessageSchema,
  uuid,
} from "./common.js";

export const agentSchema = z.strictObject({
  finishSchema: z
    .record(z.string(), z.json())
    .superRefine((schema, ctx) => {
      if (schema.type !== "object")
        ctx.addIssue({
          code: "custom",
          message: "Finish schema must describe an object",
        });
      try {
        z.fromJSONSchema(schema);
      } catch {
        ctx.addIssue({ code: "custom", message: "Unsupported finish schema" });
      }
    })
    .nullable()
    .default(null),
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
  mode: z.enum(["singleTurn", "agentLoop"]),
  modelID: id,
  executionClass: z.enum(["background", "instant"]).default("background"),
  skillIDs: z.array(id).max(40),
  toolIDs: z.array(toolID).max(64),
  thinking: z.boolean().default(true),
  maxToolCalls: z.number().int().min(1).max(1000).optional(),
  sampling: samplingSchema.default(() => samplingSchema.parse({})),
  parallelToolCalls: z.boolean().optional(),
  maxOutputTokens: z.number().int().min(1).max(32768).default(4096),
  timeoutMs: z.number().int().min(1000).max(86400000),
  enabled: z.boolean(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export const agentSummarySchema = agentSchema.pick({
  agentID: true,
  name: true,
  revision: true,
  modelID: true,
  mode: true,
  executionClass: true,
  contextMode: true,
  enabled: true,
  updatedAt: true,
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
export const triggerInfoSchema = triggerSchema.extend({
  nextFireAt: z.string().nullable(),
  automaticDispatchEnabled: z.boolean(),
  blockers: z.array(z.string()),
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
export type Agent = z.infer<typeof agentSchema>;
export type Skill = z.infer<typeof skillSchema>;
