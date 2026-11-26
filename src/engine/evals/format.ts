import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { agentSchema } from "../../schemas/agent.js";
import { id, messageSchema, timestamp } from "../../schemas/common.js";
import { canonical } from "../../utils/json.js";

export const jsonObject = z.record(z.string(), z.json());
export const gradingSchema = jsonObject.superRefine((value, ctx) => {
  try {
    z.fromJSONSchema(value);
  } catch {
    ctx.addIssue({
      code: "custom",
      message: "Unsupported grading JSON Schema",
    });
  }
});
export const graderExecSchema = z.strictObject({
  executablePath: z
    .string()
    .refine(path.isAbsolute, "Expected an absolute executable path"),
  argv: z.array(z.string().max(4000)).max(64).default([]),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
  sourceFiles: z.array(z.string().refine(path.isAbsolute)).max(32).default([]),
});
export const graderSchema = z
  .strictObject({
    schema: gradingSchema.optional(),
    exec: graderExecSchema.optional(),
  })
  .refine((v) => !!v.schema || !!v.exec, "Specify schema or exec");
export const authorMessage = messageSchema.extend({
  messageID: messageSchema.shape.messageID.optional(),
  role: z.enum(["user", "assistant", "tool"]),
  attachments: messageSchema.shape.attachments.default([]),
  toolCalls: messageSchema.shape.toolCalls.default([]),
  toolCallID: messageSchema.shape.toolCallID.default(null),
});
export const toolOverrideSchema = z.strictObject({
  tool: id.refine((v) => v !== "finish", "finish is runtime-owned"),
  input: jsonObject.optional(),
  output: z
    .json()
    .refine(
      (value) =>
        Buffer.byteLength(
          typeof value === "string" ? value : JSON.stringify(value),
        ) <= 1048576,
      "Tool response exceeds 1 MB",
    ),
});
export const overrideSchema = z.strictObject({
  modelID: agentSchema.shape.modelID.optional(),
  thinking: agentSchema.shape.thinking.removeDefault().optional(),
  systemPrompt: agentSchema.shape.systemPrompt.optional(),
  temperature: agentSchema.shape.temperature.removeDefault().optional(),
  sampling: agentSchema.shape.sampling,
  maxOutputTokens: agentSchema.shape.maxOutputTokens.removeDefault().optional(),
  maxToolCalls: agentSchema.shape.maxToolCalls,
  timeoutMs: agentSchema.shape.timeoutMs.optional(),
});
export const evalFields = {
  evalID: id,
  agentID: id,
  overrides: overrideSchema.default({}),
  messages: z.array(authorMessage).max(1000).default([]),
  tools: z.array(toolOverrideSchema).max(1000).default([]),
  grader: graderSchema.nullish(),
};
export const evalSchema = z
  .strictObject(evalFields)
  .superRefine((value, ctx) => {
    const keys = value.tools.map((t) => canonical([t.tool, t.input ?? null]));
    if (new Set(keys).size !== keys.length)
      ctx.addIssue({
        code: "custom",
        message: "Duplicate tool response match",
      });
    const IDs = new Set<string>(),
      calls = new Set<string>(),
      answered = new Set<string>();
    for (const m of value.messages) {
      if (m.messageID) {
        if (IDs.has(m.messageID))
          ctx.addIssue({ code: "custom", message: "Duplicate message UUID" });
        IDs.add(m.messageID);
      }
      if (m.role !== "assistant" && m.toolCalls.length)
        ctx.addIssue({
          code: "custom",
          message: "Only assistant messages can call tools",
        });
      if (m.role !== "user" && m.attachments.length)
        ctx.addIssue({
          code: "custom",
          message: "Only user messages can have attachments",
        });
      if (m.role !== "tool" && [...calls].some((c) => !answered.has(c)))
        ctx.addIssue({
          code: "custom",
          message: "Unanswered tool call before a later message",
        });
      for (const c of m.toolCalls) {
        if (calls.has(c.callID))
          ctx.addIssue({ code: "custom", message: "Duplicate tool call ID" });
        calls.add(c.callID);
      }
      if (m.role === "tool") {
        if (
          !m.toolCallID ||
          !calls.has(m.toolCallID) ||
          answered.has(m.toolCallID)
        )
          ctx.addIssue({
            code: "custom",
            message: "Orphan or duplicate tool result",
          });
        if (m.toolCallID) answered.add(m.toolCallID);
      } else if (m.toolCallID)
        ctx.addIssue({
          code: "custom",
          message: "Only tool results can reference tool calls",
        });
    }
    if (
      value.messages.some((m) =>
        m.toolCalls.some((c) => c.name === "finish" && !answered.has(c.callID)),
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "A seeded finish call must already have its tool result; the evaluated model must produce the new finish",
      });
  });
export type EvalDefinition = z.infer<typeof evalSchema>;
export const evalRecordSchema = z.strictObject({
  revision: z.number().int().positive(),
  definition: evalSchema,
});
export const graderSnapshotSchema = graderExecSchema.extend({
  workingDirectory: z.string(),
  files: z.array(
    z.strictObject({
      path: z.string(),
      resolvedPath: z.string(),
      sha256: z.string(),
    }),
  ),
  identityHash: z.string(),
});
export const gradeSchema = z.strictObject({
  status: z.enum([
    "pending",
    "running",
    "passed",
    "failed",
    "error",
    "ungraded",
  ]),
  reason: z.string().max(8000).optional(),
  schema: z
    .strictObject({
      passed: z.boolean(),
      issues: z
        .array(z.strictObject({ path: z.string(), message: z.string() }))
        .max(100),
    })
    .optional(),
  exec: z
    .strictObject({ passed: z.boolean(), reason: z.string().max(8000) })
    .optional(),
  startedAt: timestamp.optional(),
  finishedAt: timestamp.optional(),
});
export const evalRunStateSchema = z.strictObject({
  definition: evalSchema,
  revision: z.number().int().positive(),
  initialMessages: z.number().int().nonnegative(),
  grader: graderSnapshotSchema.optional(),
  grade: gradeSchema,
});

export function normalizeEval(input: unknown): EvalDefinition {
  const value = evalSchema.parse(input);
  return {
    ...value,
    messages: value.messages.map((m) => ({
      ...m,
      messageID: m.messageID ?? randomUUID(),
    })),
  };
}
