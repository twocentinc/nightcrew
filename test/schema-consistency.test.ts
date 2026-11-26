import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { executableSchema, toolDefinitionSchema } from "../dist/schemas/tool.js";
import { hookSchema } from "../dist/schemas/hook.js";
import { agentDraftSchema } from "../dist/schemas/agent.js";
import { chatInputSchema } from "../dist/schemas/common.js";
import { schedulerSchema } from "../dist/engine/scheduling/policy.js";
import { compactionSchema, structuredSummarySchema, structuredSummaryJSONSchema } from "../dist/engine/compaction/format.js";
import { graderExecSchema } from "../dist/engine/evals/format.js";
import { upgradeContract, upgradeDefinition } from "../dist/storage/schemaMigration.js";
import { executionRecord, workingExecution } from "../dist/schemas/execution.js";

const exec = { executablePath: "/usr/bin/true", argv: ["a b", "%literal%"], timeoutMs: 1234 };
test("all executable handlers accept the same command fields and reject arguments aliases", () => {
  const handlers = [
    executableSchema,
    hookSchema.omit({ hookID: true, purpose: true, event: true }),
    graderExecSchema.omit({ sourceFiles: true }),
    schedulerSchema.shape.hook.unwrap().unwrap().omit({ failurePolicy: true }),
  ];
  for (const schema of handlers) {
    assert.deepEqual(schema.parse(exec), exec);
    assert.equal(schema.safeParse({ ...exec, arguments: [] }).success, false);
  }
  const tool = {toolID: "test", description: "test", parameters: {type: "object"}, ...exec};
  assert.deepEqual(toolDefinitionSchema.parse(tool), tool);
  assert.equal(toolDefinitionSchema.safeParse({...tool, arguments: []}).success, false);
  assert.deepEqual(compactionSchema.parse({ handler: { type: "exec", ...exec } }).handler, { type: "exec", ...exec });
});
test("schema migration consolidates output constraints without weakening either schema", () => {
  const old = {
    agentID: "test", name: "test", systemPrompt: "test", mode: "agent-loop", modelID: "q",
    skillIDs: [], toolIDs: [], enabled: true, timeoutMs: 30000,
    revision: 1, createdAt: "2026-11-26T00:00:00.000Z", updatedAt: "2026-11-26T00:00:00.000Z",
    temperature: 0.2, sampling: { topK: 20, parallelToolCalls: false },
    finishSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
    outputValidation: { validator: { type: "json-schema", schema: { type: "object", properties: { answer: { type: "number", minimum: 10 } } } } },
  };
  const next = upgradeContract(old);
  const validator = z.fromJSONSchema(next.finishSchema);
  assert.equal(validator.safeParse({ answer: 12 }).success, true);
  assert.equal(validator.safeParse({ answer: 2 }).success, false);
  assert.equal(validator.safeParse({ answer: "12" }).success, false);
  assert.equal(next.mode, "agentLoop");
  assert.deepEqual(next.sampling, { temperature: 0.2, topK: 20 });
  assert.equal(next.parallelToolCalls, false);
  assert.equal("temperature" in next, false);
  assert.equal("outputValidation" in next, false);
  assert.equal(agentDraftSchema.safeParse({ ...next, outputValidation: old.outputValidation }).success, false);
  const def = upgradeDefinition({ evalID: "e", agentID: "test", overrides: { temperature: 0.1 }, tools: [{tool: "read", output: {tool: "leave this data alone"}}] });
  assert.deepEqual(def.tools, [{ toolID: "read", output: {tool: "leave this data alone"} }]);
  assert.deepEqual(def.overrides, { sampling: { temperature: 0.1 } });
});
test("invalidOutput preserves diagnostics through execution serialization", () => {
  const execution = {state: "invalidOutput" as const, error: {code: "invalid_finish", message: "wrong shape"}};
  assert.deepEqual(executionRecord(workingExecution(execution)), execution);
});
test("generated compaction JSON Schema enforces the canonical summary structure", () => {
  const modelSchema = z.fromJSONSchema(structuredSummaryJSONSchema);
  const valid = {objective: [{text: "Continue work", sources: []}], decisions: [], findings: [], nextActions: []};
  for (const value of [valid, {...valid, extra: true}, {...valid, findings: [{text: "src:1234567890abcdef", sources: []}]}, {...valid, findings: [{text: "fact", sources: ["invented"]}]}])
    assert.equal(modelSchema.safeParse(value).success, structuredSummarySchema.safeParse(value).success);
});

test("historical completed output is not reported as awaiting a check that will never run", async () => {
  const {runOutcome} = await import("../dist/engine/supervision.js");
  const run = {state: "completed", turnID: "turn", validations: [], hookReceipts: [], events: [],
    agent: {finishSchema: {type: "object"}, finishValidator: null}, deliveryExpected: false} as unknown as Parameters<typeof runOutcome>[0];
  assert.equal(runOutcome(run).output, "notChecked");
  assert.equal("task" in runOutcome(run), false);
});

test("bundled authoring requests use current agent fields", async () => {
  const {readFile} = await import("node:fs/promises");
  for (const folder of ["hello-world", "granite-transcription", "summarizer", "agent-supervisor"]) {
    const request = JSON.parse(await readFile(new URL(`../examples/${folder}/agent.json`, import.meta.url), "utf8"));
    assert.equal(agentDraftSchema.safeParse(request.agent).success, true, folder);
  }
});
