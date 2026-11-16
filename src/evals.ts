import { withSkillCatalog } from "./skills.js";
import { z } from "zod";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile, rename } from "node:fs/promises";
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
import { canonical } from "./storage.js";
import { checkpoint, pause, withoutExecution } from "./execution.js";

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
export const evalSuiteSchema = z
  .strictObject({
    format: z.literal("nightcrew.eval"),
    version: z.literal(1),
    suiteID: id,
    description: z.string().max(4000).default(""),
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
  z.object({changed:z.literal(false),suiteID:z.string(),cases:z.number().int(),snapshot:z.object({
    agent:agentSchema, tools:z.array(functionToolSchema), skills:z.array(z.object({skillID:z.string(),name:z.string(),description:z.string()})),
    model:modelSchema.optional(),systemPrompt:z.string(),limits:z.object({maxToolCalls:z.number().int(),maxOutputTokens:z.number().int(),timeoutMs:z.number().int()}),compaction:z.literal("disabled"),hooks:z.literal("disabled"),
  })}),
  z.object({suiteID:z.string(),destination:z.string(),resultFile:z.string(),cases:z.array(z.object({caseID:z.string(),status:z.enum(["passed","failed","needs_review","error"]),error:z.string().nullable()})),status:z.enum(["passed","failed","needs_review"])}),
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
  const snapshot = {
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
            await transport("inference get", {}, activeRequest),
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
            transport("inference cancel", {}, activeRequest),
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
