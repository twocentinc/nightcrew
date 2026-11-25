import { withSkillCatalog } from "./skills.js";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, writeFile, rename, stat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  agentSchema,
  modelSchema,
  messageSchema,
  functionToolSchema,
  chatInputSchema,
  id,
  type Message,
} from "./contracts.js";
import { canonical } from "../storage/store.js";
import {
  checkpoint,
  pause,
  withoutExecution,
  runExecutable,
  remainingTimeout,
  executionSignal,
} from "./execution.js";

const jsonObject = z.record(z.string(), z.json());
const authorMessage = messageSchema.omit({ messageID: true }).extend({
  role: z.enum(["user", "assistant", "tool"]),
  attachments: messageSchema.shape.attachments.default([]),
  toolCalls: messageSchema.shape.toolCalls.default([]),
  toolCallID: messageSchema.shape.toolCallID.default(null),
});
const assertion = z.discriminatedUnion("type", [
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
const graderSnapshotSchema = evalGraderSchema.extend({
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
async function hashGraderFile(file: string) {
  const resolvedPath = await realpath(file),
    info = await stat(resolvedPath);
  if (!info.isFile() || info.size > 256 * 1024 * 1024)
    throw Error("Invalid or oversized grader file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolvedPath)) {
    checkpoint();
    hash.update(chunk);
  }
  return { path: file, resolvedPath, sha256: hash.digest("hex") };
}
async function snapshotGrader(grader: z.infer<typeof evalGraderSchema>) {
  const paths = new Set([grader.executablePath, ...grader.sourceFiles]);
  // Capture script arguments automatically; declared sourceFiles cover imports/data.
  for (const arg of grader.argv) {
    if (arg.startsWith("-")) continue;
    const file = path.resolve(arg);
    if ((await stat(file).catch(() => null))?.isFile()) paths.add(file);
  }
  const files = await Promise.all([...paths].map(hashGraderFile));
  const snapshot = { ...grader, workingDirectory: process.cwd(), files };
  return { ...snapshot, identityHash: digest(snapshot) };
}

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
type Transport = (
  command: string,
  request?: unknown,
  resourceID?: string,
) => Promise<unknown>;
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
const sampleResult = z.object({
  text: z.string(),
  reasoningContent: z.string().optional(),
  toolCalls: messageSchema.shape.toolCalls,
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
});
const detailSchema = z.object({
  state: z.string(),
  result: sampleResult.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});

export function checkEvalAnswer(
  c: EvalSuite["cases"][number],
  answer: string,
  counts: Record<string, number>,
) {
  return c.expectations.assertions.map((a) => {
    let passed = false;
    if (a.type === "finalContains") passed = answer.includes(a.text);
    if (a.type === "finalNotContains") passed = !answer.includes(a.text);
    if (a.type === "mockCallCount")
      passed =
        (counts[a.mockID] ?? 0) >= a.min && (counts[a.mockID] ?? 0) <= a.max;
    if (a.type === "finalJSONSchema") {
      try {
        passed = z
          .fromJSONSchema(a.schema)
          .safeParse(JSON.parse(answer)).success;
      } catch {}
    }
    return { assertionID: a.assertionID, passed };
  });
}

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

export async function runEval(
  raw: unknown,
  transport: Transport,
  dryRun = false,
) {
  const { suite, destination } = evalRunSchema.parse(raw);
  const { item: agent } = z
    .object({ item: agentSchema })
    .parse(await transport("agents get", {}, suite.agent.agentID));
  if (
    suite.agent.expectedRevision !== undefined &&
    suite.agent.expectedRevision !== agent.revision
  )
    throw Error("Agent revision changed");
  const effectiveAgent = { ...agent, ...suite.overrides };
  let systemPrompt = effectiveAgent.systemPrompt;
  if (agent.outputValidation?.validator.type === "json-schema")
    systemPrompt +=
      "\n\nFinal output must be JSON matching this schema: " +
      JSON.stringify(agent.outputValidation.validator.schema);
  const limits = {
    maxToolCalls: Math.min(
      suite.limits.maxToolCalls,
      agent.maxToolCalls ?? suite.limits.maxToolCalls,
    ),
    maxOutputTokens: Math.min(
      suite.limits.maxOutputTokens,
      agent.maxOutputTokens,
    ),
    timeoutMs: Math.min(suite.limits.timeoutMs, agent.timeoutMs),
  };
  const skills: Array<{ skillID: string; name: string; description: string }> =
    [];
  for (const skillID of agent.mode === "agent-loop" ? agent.skillIDs : []) {
    const response = z
      .object({
        item: z.object({
          skillID: z.string(),
          name: z.string(),
          description: z.string(),
        }),
      })
      .parse(await transport("skills get", {}, skillID));
    skills.push(response.item);
  }
  const tools = [];
  for (const name of agent.mode === "single-turn"
    ? []
    : [...new Set([...agent.toolIDs, "load_skills"])]) {
    const result = z
      .object({
        item: z.object({
          toolID: z.string(),
          description: z.string(),
          parameters: jsonObject,
        }),
      })
      .parse(await transport("tools get", {}, name));
    tools.push(
      functionToolSchema.parse({
        name: result.item.toolID,
        description: result.item.description,
        parameters: result.item.parameters,
      }),
    );
  }
  for (const c of suite.cases)
    for (const mock of c.mocks) {
      const tool = tools.find((t) => t.name === mock.tool);
      if (!tool) throw Error("Mock names an unavailable tool: " + mock.tool);
      // Validate, but match the original JSON. Schema defaults never alter a mock key.
      z.fromJSONSchema(tool.parameters).parse(mock.arguments);
    }
  const config = z
    .object({
      config: z.object({
        models: z.array(z.object({ modelID: z.string() }).passthrough()),
        scheduler: z
          .object({ instantModelID: z.string().nullable() })
          .passthrough(),
      }),
    })
    .parse(await transport("config get"));
  if (config.config.scheduler.instantModelID !== agent.modelID)
    throw Error(
      "Eval v1 requires the configured instant model to match the agent model",
    );
  const model = config.config.models.find((m) => m.modelID === agent.modelID);
  const graders = await Promise.all(suite.graders.map(snapshotGrader));
  const snapshot = {
    graders,
    agent: effectiveAgent,
    tools,
    skills,
    model,
    systemPrompt,
    limits,
    compaction: "disabled",
    hooks: "disabled",
  };
  if (dryRun)
    return {
      changed: false,
      suiteID: suite.suiteID,
      cases: suite.cases.length,
      snapshot,
    };
  await mkdir(destination, { mode: 0o700 }); // create-only, never overwrite another run
  const results: Array<Record<string, unknown>> = [];
  const save = async () => {
    const report = {
      format: "nightcrew.eval.result",
      version: 1,
      suiteID: suite.suiteID,
      suiteHash: digest(suite),
      snapshotHash: digest(snapshot),
      suite,
      snapshot,
      cases: results,
    };
    await writeFile(
      path.join(destination, "result.tmp"),
      JSON.stringify(report, null, 2) + "\n",
      { mode: 0o600 },
    );
    await rename(
      path.join(destination, "result.tmp"),
      path.join(destination, "result.json"),
    );
  };
  await save();
  for (const c of suite.cases) {
    const started = Date.now(),
      deadline = started + limits.timeoutMs;
    const counts: Record<string, number> = {};
    const messages: Message[] = withSkillCatalog(
      [
        {
          messageID: randomUUID(),
          role: "system",
          content: systemPrompt,
          attachments: [],
          toolCalls: [],
          toolCallID: null,
        },
        ...c.context.messages.map((m) => ({ ...m, messageID: randomUUID() })),
      ],
      skills,
    );
    const record: Record<string, unknown> = {
      caseID: c.caseID,
      status: "running",
      messages,
      counts,
      requests: [],
      samples: [],
    };
    const requestIDs: string[] = [];
    record.requests = requestIDs;
    const samples: unknown[] = [];
    record.samples = samples;
    results.push(record);
    let answer = "",
      totalCalls = 0,
      activeRequest: string | undefined;
    const callIDs = new Set(
      messages.flatMap((m) => m.toolCalls.map((t) => t.callID)),
    );
    try {
      for (;;) {
        checkpoint();
        if (Date.now() >= deadline) throw Error("timeout");
        const request = evalSampleSchema.parse({
          conversationID: randomUUID(),
          modelID: agent.modelID,
          messages: messages.map((m) =>
            m.role === "user" ? { ...m, thinking: agent.thinking } : m,
          ),
          tools: c.mocks.length ? tools : [],
          maxOutputTokens: limits.maxOutputTokens,
          temperature: agent.temperature,
          sampling: agent.sampling,
          timeoutMs: Math.max(1000, deadline - Date.now()),
        });
        const accepted = z
          .object({ requestID: z.string() })
          .parse(await transport("evals sample", request));
        activeRequest = accepted.requestID;
        requestIDs.push(activeRequest);
        await save();
        let detail;
        do {
          checkpoint();
          if (Date.now() >= deadline) throw Error("timeout");
          detail = detailSchema.parse(
            await transport("instant get", {}, activeRequest),
          );
          if (
            ["completed", "failed", "timedOut", "cancelled"].includes(
              detail.state,
            )
          )
            break;
          await pause(100);
        } while (true);
        record.lastSample = detail;
        await save();
        await transport("evals release", {}, accepted.requestID);
        activeRequest = undefined;
        if (detail.state !== "completed" || !detail.result)
          throw Error(detail.error?.code ?? detail.state);
        const result = detail.result;
        samples.push(result);
        await save();
        const assistant: Message = {
          messageID: randomUUID(),
          role: "assistant",
          content: result.text,
          attachments: [],
          toolCalls: result.toolCalls,
          toolCallID: null,
          ...(result.reasoningContent
            ? { reasoningContent: result.reasoningContent }
            : {}),
        };
        messages.push(assistant);
        await save();
        if (!result.toolCalls.length) {
          answer = result.text;
          break;
        }
        for (const call of result.toolCalls) {
          if (++totalCalls > limits.maxToolCalls) throw Error("tool_budget");
          if (callIDs.has(call.callID))
            throw Error("fixture_mismatch: duplicate callID");
          callIDs.add(call.callID);
          const tool = (c.mocks.length ? tools : []).find(
            (t) => t.name === call.name,
          );
          if (!tool)
            throw Error("fixture_mismatch: unavailable tool " + call.name);
          let args;
          try {
            args = JSON.parse(call.arguments);
            z.fromJSONSchema(tool.parameters).parse(args);
          } catch {
            throw Error("fixture_mismatch: invalid arguments");
          }
          const mock = c.mocks.find(
            (m) =>
              m.tool === call.name &&
              canonical(m.arguments) === canonical(args),
          );
          if (!mock)
            throw Error(
              "fixture_mismatch: unmatched arguments for " + call.name,
            );
          const index = counts[mock.mockID] ?? 0;
          const response =
            mock.responses[index] ??
            (mock.afterExhausted === "repeatLast"
              ? mock.responses.at(-1)
              : undefined);
          if (!response)
            throw Error("fixture_mismatch: exhausted " + mock.mockID);
          counts[mock.mockID] = index + 1;
          messages.push({
            messageID: randomUUID(),
            role: "tool",
            content:
              response.type === "result"
                ? response.content
                : JSON.stringify({
                    ok: false,
                    error: {
                      code: "tool_execution_failed",
                      message: response.message,
                      outcome: "unknown",
                    },
                  }),
            attachments: [],
            toolCalls: [],
            toolCallID: call.callID,
          });
          await save();
        }
        if (Buffer.byteLength(JSON.stringify(messages)) > 4 * 1024 * 1024)
          throw Error("context_limit");
      }
      record.assertions = checkEvalAnswer(c, answer, counts);
      record.criteria = c.expectations.criteria.map((criterion) => ({
        ...criterion,
        status: "unreviewed",
      }));
      const checks = checkEvalAnswer(c, answer, counts);
      record.status = checks.some((a) => !a.passed)
        ? "failed"
        : c.expectations.criteria.length || !checks.length
          ? "needs_review"
          : "passed";
    } catch (error) {
      record.status = "error";
      record.error = error instanceof Error ? error.message : "eval_failed";
      if (activeRequest) {
        try {
          await withoutExecution(() =>
            transport("instant cancel", {}, activeRequest),
          );
        } catch {
          record.cancellation = "unconfirmed; inspect request ID";
        }
      }
    }
    record.answer = answer;
    record.elapsedMs = Date.now() - started;
    record.assertions ??= checkEvalAnswer(c, answer, counts);
    record.criteria ??= c.expectations.criteria.map((criterion) => ({
      ...criterion,
      status: "unreviewed",
    }));
    // Persist execution evidence before running trusted evaluator code. A crashed
    // evaluator must not erase the model trace or turn an execution error into a pass.
    const executionStatus = record.status;
    if (graders.length) {
      record.gradingComplete = false;
      if (executionStatus === "passed") record.status = "needs_review";
    }
    await save();
    const grades: Array<Record<string, unknown>> = [];
    record.graders = grades;
    const reviewed = new Map<string, string>();
    let graderError = false,
      graderFailed = false,
      graderNeedsReview = false;
    for (const grader of graders) {
      try {
        checkpoint();
        for (const original of grader.files) {
          const current = await hashGraderFile(original.path);
          if (
            current.sha256 !== original.sha256 ||
            current.resolvedPath !== original.resolvedPath
          )
            throw Error("Grader changed after snapshot");
        }
        const input = JSON.stringify({
          version: 1,
          suiteID: suite.suiteID,
          graderID: grader.graderID,
          case: c,
          snapshot,
          result: { ...record, graders: undefined, status: executionStatus },
        });
        if (Buffer.byteLength(input) > 16 * 1024 * 1024)
          throw Error("Grader input limit");
        const output = await runExecutable({
          executable: grader.executablePath,
          argv: grader.argv,
          input,
          env: { PATH: process.env.PATH ?? "" },
          timeoutMs: remainingTimeout(grader.timeoutMs),
          signal: executionSignal(),
          errors: {
            timeout: "Grader timed out",
            interrupted: "Grader interrupted",
            limit: "Grader output limit",
            failed: (code, signal) =>
              "Grader process failed (exit " +
              code +
              ", signal " +
              signal +
              ")",
          },
        });
        const grade = evalGradeSchema.parse(
          JSON.parse(output.toString("utf8")),
        );
        for (const check of grade.checks)
          if (
            check.criterionID &&
            !c.expectations.criteria.some(
              (x) => x.criterionID === check.criterionID,
            )
          )
            throw Error("Unknown grader criterionID: " + check.criterionID);
        for (const check of grade.checks) {
          graderFailed ||= check.status === "failed";
          graderNeedsReview ||= check.status === "needs_review";
          if (check.criterionID) {
            const old = reviewed.get(check.criterionID);
            reviewed.set(
              check.criterionID,
              old === "failed" || check.status === "failed"
                ? "failed"
                : old === "needs_review" || check.status === "needs_review"
                  ? "needs_review"
                  : "passed",
            );
          }
        }
        grades.push({
          graderID: grader.graderID,
          identityHash: grader.identityHash,
          status: "completed",
          ...grade,
        });
      } catch (error) {
        graderError = true;
        grades.push({
          graderID: grader.graderID,
          identityHash: grader.identityHash,
          status: "error",
          error:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : "Grader failed",
        });
      }
      await save();
    }
    if (graders.length) record.gradingComplete = true;
    record.criteria = c.expectations.criteria.map((criterion) => ({
      ...criterion,
      status: reviewed.get(criterion.criterionID) ?? "unreviewed",
    }));
    if (graderError) {
      record.status = "error";
      record.error ??= "grader_error";
    } else if (executionStatus !== "error") {
      const checks = checkEvalAnswer(c, answer, counts);
      record.status =
        checks.some((x) => !x.passed) || graderFailed
          ? "failed"
          : graderNeedsReview ||
              c.expectations.criteria.some(
                (x) => !reviewed.has(x.criterionID),
              ) ||
              (!checks.length && !grades.length)
            ? "needs_review"
            : "passed";
    }
    await save();
  }
  return {
    suiteID: suite.suiteID,
    destination,
    resultFile: path.join(destination, "result.json"),
    cases: results.map((r) => ({
      caseID: r.caseID,
      status: r.status,
      error: r.error ?? null,
    })),
    status: results.some((r) => r.status === "error" || r.status === "failed")
      ? "failed"
      : results.some((r) => r.status === "needs_review")
        ? "needs_review"
        : "passed",
  };
}
