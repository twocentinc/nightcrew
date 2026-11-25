import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { agentSchema } from "../../schemas/agent.js";
import {
  functionToolSchema,
  messageSchema,
  type Message,
} from "../../schemas/common.js";
import { fingerprint } from "../../utils/json.js";
import { withSkillCatalog } from "../capabilities/skills.js";
import { checkpoint, pause, withoutExecution } from "../execution/process.js";
import { evalRunSchema, evalSampleSchema, jsonObject } from "./format.js";
import { checkEvalAnswer, gradeCase, snapshotGrader } from "./results.js";
import { dispatchMock } from "./tools.js";

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
          const response = dispatchMock(call, c, tools, callIDs, counts);
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
    await gradeCase({
      record,
      graders,
      suite,
      c,
      snapshot,
      answer,
      counts,
      save,
    });
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
export type Transport = (
  command: string,
  request?: unknown,
  resourceID?: string,
) => Promise<unknown>;
export const digest = (value: unknown) => fingerprint(value);
export const sampleResult = z.object({
  text: z.string(),
  reasoningContent: z.string().optional(),
  toolCalls: messageSchema.shape.toolCalls,
  usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
});
export const detailSchema = z.object({
  state: z.string(),
  result: sampleResult.nullable(),
  error: z.object({ code: z.string(), message: z.string() }).nullable(),
});
