import path from "node:path";
import { z } from "zod";
import { agentSchema } from "../../schemas/agent.js";
import {
  chatInputSchema,
  functionToolSchema,
  id,
  messageSchema,
} from "../../schemas/common.js";
import { modelSchema } from "../../schemas/model.js";
import { canonical } from "../../utils/json.js";

export const jsonObject = z.record(z.string(), z.json());
export const authorMessage = messageSchema.omit({ messageID: true }).extend({
  role: z.enum(["user", "assistant", "tool"]),
  attachments: messageSchema.shape.attachments.default([]),
  toolCalls: messageSchema.shape.toolCalls.default([]),
  toolCallID: messageSchema.shape.toolCallID.default(null),
});
export const assertion = z.discriminatedUnion("type", [
  z.strictObject({
    assertionID: id,
    type: z.literal("finalContains"),
    text: z.string().min(1),
  }),
  z.strictObject({
    assertionID: id,
    type: z.literal("finalNotContains"),
    text: z.string().min(1),
  }),
  z.strictObject({
    assertionID: id,
    type: z.literal("finalJSONSchema"),
    schema: jsonObject,
  }),
  z.strictObject({
    assertionID: id,
    type: z.literal("mockCallCount"),
    mockID: id,
    min: z.number().int().nonnegative(),
    max: z.number().int().nonnegative(),
  }),
]);
export const evalGraderSchema = z.strictObject({
  graderID: id,
  executablePath: z
    .string()
    .refine(path.isAbsolute, "Grader executable must be absolute"),
  argv: z.array(z.string().max(4000)).max(64).default([]),
  timeoutMs: z.number().int().min(100).max(60000).default(10000),
  sourceFiles: z
    .array(
      z
        .string()
        .refine(path.isAbsolute, "Grader source files must be absolute"),
    )
    .max(32)
    .default([]),
});
export const evalGradeSchema = z
  .strictObject({
    checks: z
      .array(
        z.strictObject({
          checkID: id,
          status: z.enum(["passed", "failed", "needs_review"]),
          reason: z.string().min(1).max(4000),
          criterionID: id.optional(),
        }),
      )
      .min(1)
      .max(100),
  })
  .superRefine((grade, ctx) => {
    for (const key of ["checkID", "criterionID"] as const) {
      const values = grade.checks.flatMap((check) =>
        check[key] ? [check[key]] : [],
      );
      if (new Set(values).size !== values.length)
        ctx.addIssue({ code: "custom", message: "Duplicate " + key });
    }
  });
export const graderSnapshotSchema = evalGraderSchema.extend({
  workingDirectory: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      resolvedPath: z.string(),
      sha256: z.string(),
    }),
  ),
  identityHash: z.string(),
});
export const evalSuiteSchema = z
  .strictObject({
    format: z.literal("nightcrew.eval"),
    version: z.literal(1),
    suiteID: id,
    description: z.string().max(4000).default(""),
    graders: z.array(evalGraderSchema).max(8).default([]),
    agent: z.strictObject({
      agentID: id,
      expectedRevision: z.number().int().positive().optional(),
    }),
    overrides: z
      .strictObject({ systemPrompt: agentSchema.shape.systemPrompt.optional() })
      .default({}),
    limits: z
      .strictObject({
        maxToolCalls: z.number().int().min(0).max(100).default(16),
        maxOutputTokens: z.number().int().min(1).max(8192).default(1536),
        timeoutMs: z.number().int().min(1000).max(240000).default(120000),
      })
      .default({ maxToolCalls: 16, maxOutputTokens: 1536, timeoutMs: 120000 }),
    cases: z
      .array(
        z.strictObject({
          caseID: id,
          description: z.string().max(4000).default(""),
          context: z.strictObject({
            messages: z.array(authorMessage).min(1).max(200),
          }),
          mocks: z
            .array(
              z.strictObject({
                mockID: id,
                tool: functionToolSchema.shape.name,
                arguments: jsonObject,
                responses: z
                  .array(
                    z.discriminatedUnion("type", [
                      z.strictObject({
                        type: z.literal("result"),
                        content: z.string().max(262144),
                      }),
                      z.strictObject({
                        type: z.literal("error"),
                        message: z.string().max(4000),
                      }),
                    ]),
                  )
                  .min(1)
                  .max(100),
                afterExhausted: z.enum(["fail", "repeatLast"]).default("fail"),
              }),
            )
            .max(100)
            .default([]),
          expectations: z.strictObject({
            assertions: z.array(assertion).max(100).default([]),
            criteria: z
              .array(
                z.strictObject({
                  criterionID: id,
                  description: z.string().min(1).max(4000),
                  severity: z.enum(["critical", "normal"]),
                }),
              )
              .max(100)
              .default([]),
          }),
        }),
      )
      .min(1)
      .max(25),
  })
  .superRefine((suite, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const unique = (values: string[], label: string) => {
      if (new Set(values).size !== values.length) issue("Duplicate " + label);
    };
    unique(
      suite.graders.map((g) => g.graderID),
      "graderID",
    );
    unique(
      suite.cases.map((c) => c.caseID),
      "caseID",
    );
    for (const c of suite.cases) {
      unique(
        c.mocks.map((m) => m.mockID),
        "mockID",
      );
      unique(
        c.mocks.map((m) => canonical([m.tool, m.arguments])),
        "mock match",
      );
      unique(
        c.expectations.assertions.map((a) => a.assertionID),
        "assertionID",
      );
      unique(
        c.expectations.criteria.map((a) => a.criterionID),
        "criterionID",
      );
      const pending = new Set<string>(),
        seen = new Set<string>();
      for (const m of c.context.messages) {
        if (m.role === "tool") {
          if (!m.toolCallID || !pending.delete(m.toolCallID))
            issue("Orphan tool result");
        } else if (pending.size || m.toolCallID !== null)
          issue("Incomplete tool exchange");
        if (m.toolCalls.length && m.role !== "assistant")
          issue("Only assistant messages can call tools");
        for (const call of m.toolCalls) {
          if (seen.has(call.callID)) issue("Duplicate callID");
          seen.add(call.callID);
          pending.add(call.callID);
        }
      }
      if (pending.size || c.context.messages.at(-1)?.role === "assistant")
        issue("Context must end with a user or complete tool result");
      for (const a of c.expectations.assertions) {
        if (
          a.type === "mockCallCount" &&
          (a.min > a.max || !c.mocks.some((m) => m.mockID === a.mockID))
        )
          issue("Invalid mockCallCount");
        if (a.type === "finalJSONSchema") {
          try {
            z.fromJSONSchema(a.schema);
          } catch {
            issue("Unsupported assertion schema");
          }
        }
      }
    }
  });
export const evalSampleSchema = chatInputSchema.extend({
  skillIDs: z.array(z.never()).max(0).default([]),
  sampling: agentSchema.shape.sampling,
});
export const evalRunSchema = z.strictObject({
  suite: evalSuiteSchema,
  destination: z
    .string()
    .refine(path.isAbsolute, "Destination must be absolute"),
});
export type EvalSuite = z.infer<typeof evalSuiteSchema>;
export const evalRunResultSchema = z.union([
  z.object({
    changed: z.literal(false),
    suiteID: z.string(),
    cases: z.number().int(),
    snapshot: z.object({
      agent: agentSchema,
      tools: z.array(functionToolSchema),
      skills: z.array(
        z.object({
          skillID: z.string(),
          name: z.string(),
          description: z.string(),
        }),
      ),
      graders: z.array(graderSnapshotSchema).optional(),
      model: modelSchema.optional(),
      systemPrompt: z.string(),
      limits: z.object({
        maxToolCalls: z.number().int(),
        maxOutputTokens: z.number().int(),
        timeoutMs: z.number().int(),
      }),
      compaction: z.literal("disabled"),
      hooks: z.literal("disabled"),
    }),
  }),
  z.object({
    suiteID: z.string(),
    destination: z.string(),
    resultFile: z.string(),
    cases: z.array(
      z.object({
        caseID: z.string(),
        status: z.enum(["passed", "failed", "needs_review", "error"]),
        error: z.string().nullable(),
      }),
    ),
    status: z.enum(["passed", "failed", "needs_review"]),
  }),
]);
