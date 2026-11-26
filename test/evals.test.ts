import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { settings, agentDraft } from "./fixtures.ts";
import { evalSchema } from "../dist/engine/evals/format.js";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { Service } from "../dist/engine/service.js";
import { callOperation as rawOperation } from "../dist/utils/commands/operations.js";
import { gradeRun, snapshotGrader } from "../dist/engine/evals/results.js";
import { EvalStore } from "../dist/storage/evals.js";
const operation: (...args: Parameters<typeof rawOperation>) => Promise<any> =
  rawOperation;
const finishSchema = {
  type: "object",
  properties: { answer: { type: "string" } },
  required: ["answer"],
  additionalProperties: false,
};
const finish = (answer: string) => ({
  text: "",
  toolCalls: [
    {
      callID: randomUUID(),
      name: "finish",
      arguments: JSON.stringify({ answer }),
    },
  ],
});
const seed = () => ({
  evalID: "example",
  agentID: "worker",
  messages: [{ role: "user", content: "Read and answer." }],
});
async function until<T>(fn: () => Promise<T | false>): Promise<T> {
  for (let i = 0; i < 500; i++) {
    const v = await fn();
    if (v !== false) return v;
    await delay(10);
  }
  throw Error("Timed out");
}
async function fixture(
  t: import("node:test").TestContext,
  generate: (r: any, n: number, s: AbortSignal) => Promise<any> | any,
  extra: any = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-eval-"));
  const marker = path.join(home, "production-side-effect");
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      slots: [],
      scheduler: { instantModelID: "interactive" },
      models: [
        {
          modelID: "interactive",
          kind: "chat",
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 0,
        },
        {
          modelID: "background",
          kind: "chat",
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 0,
        },
      ],
      interactionCooldownMs: 0,
      hooks: [
        {
          hookID: "delivery",
          event: "run.completed",
          purpose: "delivery",
          executablePath: "/usr/bin/false",
          timeoutMs: 1000,
        },
      ],
    }),
  );
  const calls: any[] = [];
  const runtime = {
    countTokens: async (_r: any) => 10,
    status: () => [],
    close: async () => {},
    generate: async (r: any, s: AbortSignal) => {
      calls.push(structuredClone(r));
      return {
        text: "",
        toolCalls: [],
        usage: { inputTokens: 2, outputTokens: 2 },
        ...(await generate(r, calls.length, s)),
      };
    },
  };
  const service = new Service(new Storage(home), runtime, async () => ({
    state: "away",
    reason: "fixture",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  }));
  await service.initialize();
  t.after(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  await operation(service, {
    command: "tools create",
    request: {
      tool: {
        toolID: "inspect",
        description: "Read a record",
        parameters: {
          type: "object",
          properties: { page: { type: "number" } },
          required: ["page"],
          additionalProperties: false,
        },
        executablePath: process.execPath,
        argv: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(marker)},'tool')`,
        ],
      },
    },
  });
  await service.createAgent(
    agentDraft.parse({
      agentID: "worker",
      name: "Worker",
      modelID: "background",
      mode: "agent-loop",
      systemPrompt: "Read records and finish.",
      enabled: true,
      skillIDs: [],
      toolIDs: ["inspect"],
      finishSchema,
      maxOutputTokens: 128,
      timeoutMs: 30000,
      ...extra,
    }),
  );
  const submit = async (def: any = seed()) => {
    const accepted = await service.submitEval(evalSchema.parse(def), 1);
    const run = await until(async () => {
      const r = await service.run(accepted.runID);
      return !["pending", "running"].includes(r.evaluation!.grade.status)
        ? r
        : false;
    });
    return run;
  };
  return { home, marker, service, calls, submit, runtime };
}
test("eval uses ordinary background execution, real finish validation, exact/default mocks, and hidden schema then executable grading", async (t) => {
  const f = await fixture(t, (_r, n) =>
    n === 1
      ? {
          toolCalls: [
            { callID: "a", name: "inspect", arguments: '{"page":1}' },
            { callID: "b", name: "inspect", arguments: '{"page":2}' },
          ],
        }
      : finish("correct"),
  );
  const script = path.join(f.home, "grade.ts");
  await writeFile(
    script,
    `export {};let text='';for await(const chunk of process.stdin)text+=chunk;const input=JSON.parse(text);console.log(JSON.stringify({passed:input.result.answer==='correct',reason:'checked finish'}));`,
  );
  const r = await f.submit({
    ...seed(),
    tools: [
      { tool: "inspect", output: "default result" },
      { tool: "inspect", input: { page: 1 }, output: { value: 41 } },
    ],
    grader: {
      schema: { ...finishSchema, properties: { answer: { const: "correct" } } },
      exec: {
        executablePath: process.execPath,
        argv: ["--experimental-strip-types", script],
      },
    },
  });
  assert.equal(r.state, "completed");
  assert.equal(
    r.evaluation!.grade.status,
    "passed",
    JSON.stringify(r.evaluation!.grade),
  );
  assert.equal(r.evaluation!.grade.schema!.passed, true);
  assert.equal(r.evaluation!.grade.exec!.passed, true);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].modelID, "background");
  assert.equal(f.calls[0].persistContext, false);
  assert.deepEqual(r.agent.finishSchema, finishSchema);
  assert.equal(
    r.messages.find((m) => m.toolCallID === "a")!.content,
    '{"value":41}',
  );
  assert.equal(
    r.messages.find((m) => m.toolCallID === "b")!.content,
    "default result",
  );
  assert.ok(!JSON.stringify(f.calls).includes("checked finish"));
  assert.ok(!JSON.stringify(f.calls).includes(script));
  assert.equal(r.deliveryExpected, false);
  assert.equal(r.hookReceipts.length, 0);
  await assert.rejects(access(f.marker));
  assert.ok(r.events.some((e) => e.type === "evalGraded"));
});
test("schema failure skips executable and is not sent back as repair feedback", async (t) => {
  const f = await fixture(t, () => finish("wrong"));
  const r = await f.submit({
    ...seed(),
    grader: {
      schema: {
        ...finishSchema,
        properties: { answer: { const: "EXPECTED_HIDDEN" } },
      },
      exec: {
        executablePath: process.execPath,
        argv: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(f.marker)},'grader')`,
        ],
      },
    },
  });
  assert.equal(r.state, "completed");
  assert.equal(r.evaluation!.grade.status, "failed");
  assert.equal(r.evaluation!.grade.exec, undefined);
  assert.equal(f.calls.length, 1);
  assert.ok(!JSON.stringify(f.calls).includes("EXPECTED_HIDDEN"));
  await assert.rejects(access(f.marker));
});
test("unmatched and invalid tool calls are nonfatal mocked errors and never execute", async (t) => {
  const f = await fixture(t, (_r, n) =>
    n === 1
      ? {
          toolCalls: [
            { callID: "a", name: "inspect", arguments: '{"page":3}' },
            { callID: "b", name: "inspect", arguments: '{"page":"invalid"}' },
            { callID: "c", name: "load_skills", arguments: "{}" },
          ],
        }
      : finish("no data"),
  );
  const r = await f.submit({
    ...seed(),
    tools: [{ tool: "inspect", input: { page: 1 }, output: "unused" }],
  });
  assert.equal(r.evaluation!.grade.status, "ungraded");
  assert.equal(r.state, "completed");
  for (const callID of ["a", "b", "c"])
    assert.equal(
      JSON.parse(r.messages.find((m) => m.toolCallID === callID)!.content).ok,
      false,
    );
  await assert.rejects(access(f.marker));
});
test("seeded transcript continues instead of completing; unfinished tools resume normally; snapshots and persistent IDs stay isolated", async (t) => {
  const f = await fixture(t, () => finish("new"), {
    contextMode: "persistent",
  });
  const messages = [
    { role: "user", content: "question" },
    { role: "assistant", content: "old answer" },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        { callID: "seed-call", name: "inspect", arguments: '{"page":0}' },
      ],
    },
  ];
  const def = {
    ...seed(),
    messages,
    tools: [{ tool: "inspect", output: "seed tool result" }],
  };
  const first = await f.submit(def),
    second = await f.submit(def);
  assert.notEqual(first.runID, second.runID);
  assert.ok(!first.runID.startsWith("persistent-"));
  assert.equal(first.result, '{"answer":"new"}');
  assert.equal(f.calls.length, 2);
  assert.equal(
    f.calls[0].messages.find((m: any) => m.toolCallID === "seed-call").content,
    "seed tool result",
  );
  assert.notEqual(first.messages[1]!.messageID, second.messages[1]!.messageID);
  assert.equal(first.evaluation!.definition.messages[0]!.content, "question");
});
test("grading errors and changed executables retain failure evidence", async (t) => {
  const f = await fixture(t, () => finish("yes"));
  const script = path.join(f.home, "grader.ts");
  await writeFile(script, "console.log('not json')");
  const r = await f.submit({
    ...seed(),
    grader: {
      exec: {
        executablePath: process.execPath,
        argv: ["--experimental-strip-types", script],
      },
    },
  });
  assert.equal(r.evaluation!.grade.status, "error");
  assert.ok(r.evaluation!.grade.reason);
  await writeFile(script, "console.log('{}')");
  const grade = await gradeRun(r);
  assert.equal(grade.status, "error");
  assert.match(grade.reason!, /changed/);
});
test("definition CRUD and transcript edits use one shared operation contract", async (t) => {
  const f = await fixture(t, () => finish("ok"));
  const op = (command: string, request: any = {}) =>
    operation(f.service, {
      command,
      yes: true,
      resourceID: command === "evals create" ? undefined : "example",
      request,
    });
  const created = await op("evals create", { eval: seed() });
  assert.equal(created.item.revision, 1);
  await op("evals tools set", { tool: "inspect", output: "default" });
  await op("evals tools set", {
    tool: "inspect",
    input: { page: 2 },
    output: 42,
  });
  assert.equal((await op("evals tools list")).items.length, 2);
  await op("evals tools delete", { tool: "inspect" });
  assert.equal((await op("evals tools list")).items.length, 1);
  await assert.rejects(
    op("evals update", { expectedRevision: 1, changes: { agentID: "worker" } }),
    /revision_conflict/,
  );
  await assert.rejects(
    op("evals update", { changes: { overrides: { finishSchema: {} } } }),
  );
  const messageID = (await op("evals transcript get")).messages[0].messageID;
  await op("evals transcript update", {
    messageID,
    message: { role: "user", content: "changed" },
  });
  assert.equal(
    (await op("evals transcript get")).messages[0].messageID,
    messageID,
  );
  await op("evals transcript append", {
    messages: [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ callID: "paired", name: "inspect", arguments: "{}" }],
      },
      { role: "tool", toolCallID: "paired", content: "done" },
    ],
  });
  const assistantID = (await op("evals transcript get")).messages[1].messageID;
  await op("evals transcript delete", { messageID: assistantID });
  assert.equal((await op("evals transcript get")).messages.length, 1);
  await assert.rejects(
    op("evals transcript append", {
      messages: [{ role: "tool", toolCallID: "orphan", content: "bad" }],
    }),
  );
  await op("evals transcript clear");
  assert.equal((await op("evals transcript get")).messages.length, 0);
  await assert.rejects(op("evals run"), /eval_transcript_requires_user/);
  await op("evals delete");
  assert.equal(
    (await operation(f.service, { command: "evals list", request: {} })).items
      .length,
    0,
  );
});
test("CLI file shortcuts create/edit offline definitions and reject conflicting flags", async (t) => {
  const f = await fixture(t, () => finish("ok"));
  await f.service.close();
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [path.resolve("dist/cli.js"), ...args, "--home", f.home],
        { encoding: "utf8" },
      ),
    );
  const file = path.join(f.home, "example.json"),
    output = path.join(f.home, "output.json");
  await writeFile(file, JSON.stringify(seed()));
  await writeFile(output, '{"found":true}');
  assert.equal(cli("evals", "create", "--file", file).ok, true);
  cli(
    "evals",
    "tools",
    "set",
    "example",
    "--tool",
    "inspect",
    "--output",
    output,
  );
  assert.deepEqual(
    cli("evals", "tools", "list", "example").result.items[0].output,
    { found: true },
  );
  const id = cli("evals", "transcript", "get", "example").result.messages[0]
    .messageID;
  await writeFile(
    file,
    JSON.stringify({ role: "user", content: "new prompt" }),
  );
  cli("evals", "transcript", "update", "example", id, "--file", file);
  assert.equal(
    cli("evals", "transcript", "get", "example").result.messages[0].content,
    "new prompt",
  );
  assert.throws(() =>
    cli("evals", "transcript", "delete", "example", id, "--message", id),
  );
  const defs = await new EvalStore(f.home).list();
  assert.equal(defs.length, 1);
});
test("parameter-only updates preserve tools, transcript, and agent defaults", async (t) => {
  const f = await fixture(t, () => finish("ok"), {
    thinking: false,
    temperature: 0.1,
    maxOutputTokens: 99,
  });
  const def = evalSchema.parse({ ...seed(), overrides: { temperature: 0.2 } });
  assert.deepEqual(def.overrides, { temperature: 0.2 });
  await operation(f.service, {
    command: "evals create",
    request: { eval: def },
  });
  const result = await operation(f.service, {
    command: "evals update",
    resourceID: "example",
    request: { changes: { agentID: "worker" } },
  });
  assert.equal(
    result.item.definition.messages[0].content,
    def.messages[0]!.content,
  );
  assert.deepEqual(result.item.definition.overrides, { temperature: 0.2 });
  const r = await f.submit(def);
  assert.equal(r.agent.thinking, false);
  assert.equal(r.agent.temperature, 0.2);
  assert.equal(r.agent.maxOutputTokens, 99);
});
test("eval compaction uses a linked agent and resumes the parent before grading", async (t) => {
  const f = await fixture(t, (r) =>
    r.messages[0].content.includes("Summarize the supplied")
      ? {
          text: JSON.stringify({
            summary: "Remember the prior facts; answer the question.",
          }),
        }
      : finish("done"),
  );
  await f.service.createAgent(
    agentDraft.parse({
      agentID: "summarizer",
      name: "Summarizer",
      mode: "single-turn",
      modelID: "background",
      systemPrompt: "Summarize the supplied conversation.",
      skillIDs: [],
      toolIDs: [],
      enabled: true,
      thinking: false,
      maxOutputTokens: 128,
    }),
  );
  await operation(f.service, {
    command: "agents update",
    resourceID: "worker",
    request: {
      expectedRevision: 1,
      changes: {
        compaction: { handler: { type: "agent", agentID: "summarizer" } },
      },
    },
  });
  // Make the original parent exceed capacity; child and checkpointed input fit.
  f.runtime.countTokens = async (r) =>
    r.messages.some((m: any) => m.content === "OLD_EVIDENCE") ? 4000 : 20;
  const r = await f.submit({
    ...seed(),
    messages: [
      { role: "user", content: "OLD_EVIDENCE" },
      { role: "assistant", content: "Previous answer" },
      { role: "user", content: "Now answer." },
    ],
  });
  assert.equal(r.state, "completed");
  assert.equal(r.compactions.length, 1);
  assert.equal(r.evaluation!.grade.status, "ungraded");
  const child = await f.service.run(r.compactions[0]!.childRunID!);
  assert.equal(child.state, "completed");
  assert.equal(child.parentRunID, r.runID);
  assert.equal(child.evaluation!.grade.status, "ungraded");
  assert.equal(r.events.filter((e) => e.type === "evalGraded").length, 1);
  assert.ok(
    f.calls
      .at(-1)
      .messages.some((m: any) =>
        m.content.includes("Remember the prior facts"),
      ),
  );
});
test("restart grades pending completions but does not replay an uncertain executable grader", async (t) => {
  const f = await fixture(t, () => finish("ok"));
  const one = await f.submit({ ...seed(), grader: { schema: finishSchema } }),
    two = await f.submit({ ...seed(), grader: { schema: finishSchema } });
  await f.service.close();
  const store = new Storage(f.home);
  await store.initialize();
  one.evaluation!.grade = { status: "pending" };
  two.evaluation!.grade = { status: "running" };
  await store.exclusive(async () => {
    await store.write(one);
    await store.write(two);
  });
  await store.close();
  const restarted = new Service(new Storage(f.home), f.runtime, async () => ({
    state: "away",
    reason: "fixture",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  }));
  await restarted.initialize();
  try {
    const r = await until(async () => {
      const r = await restarted.run(one.runID);
      return r.evaluation!.grade.status === "passed" ? r : false;
    });
    assert.equal(r.state, "completed");
    const unknown = await restarted.run(two.runID);
    assert.equal(unknown.evaluation!.grade.status, "error");
    assert.match(unknown.evaluation!.grade.reason!, /not retried/);
    assert.equal(f.calls.length, 2);
  } finally {
    await restarted.close();
  }
});

test("eval waits include grading and return its verdict without rerunning work", async (t) => {
  const f = await fixture(t, () => finish("done"));
  const run = await f.submit();
  const { getCommand } = await import("../dist/utils/commands/registry.js");
  const { waitForWork } = await import("../dist/cli.js");
  const command = getCommand("runs get")!;
  const original = command.handler;
  let reads = 0;
  command.handler = async () => {
    const detail = f.service.detail(run);
    detail.evaluation!.grade = {
      status: ++reads === 1 ? "running" : "failed",
      reason: "fixture verdict",
    };
    return { run: detail };
  };
  try {
    const result: any = await waitForWork(
      { home: f.home, request: {}, values: {}, dryRun: false, yes: false },
      "run",
      run.runID,
    );
    assert.equal(reads, 2);
    assert.equal(result.run.evaluation.grade.status, "failed");
    assert.equal(f.calls.length, 1);
  } finally {
    command.handler = original;
  }
});

test("seeded finish calls cannot stand in for model generation", () => {
  assert.throws(() =>
    evalSchema.parse({
      ...seed(),
      messages: [
        ...seed().messages,
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { callID: "old", name: "finish", arguments: '{"answer":"cheat"}' },
          ],
        },
      ],
    }),
  );
  assert.throws(() =>
    evalSchema.parse({ ...seed(), tools: [{ tool: "finish", output: {} }] }),
  );
});

test("eval model overrides select a different configured model without changing the installed agent", async (t) => {
  const f = await fixture(t, () => finish("done"));
  const r = await f.submit({
    ...seed(),
    overrides: { modelID: "interactive" },
  });
  assert.equal(r.agent.modelID, "interactive");
  assert.equal(f.calls[0].modelID, "interactive");
  assert.equal(r.interactive, false);
  assert.equal(
    (
      await operation(f.service, {
        command: "agents get",
        resourceID: "worker",
        request: {},
      })
    ).item.modelID,
    "background",
  );
  await assert.rejects(
    f.service.submitEval(
      evalSchema.parse({ ...seed(), overrides: { modelID: "missing" } }),
      1,
    ),
  );
});

test("replies preserve eval overrides and prior grades while regrading the new segment", async (t) => {
  const f = await fixture(t, () => finish("ok"), {
    contextMode: "persistent",
    thinking: true,
  });
  const first = await f.submit({
    ...seed(),
    overrides: { thinking: false },
    grader: { schema: finishSchema },
  });
  await f.service.submit(
    first.runID,
    { messageID: randomUUID(), content: "another turn", attachments: [] },
    true,
  );
  const second = await until(async () => {
    const r = await f.service.run(first.runID);
    return r.segment === 1 && r.evaluation!.grade.status === "passed"
      ? r
      : false;
  });
  assert.equal(second.agent.thinking, false);
  assert.equal(second.interactive, false);
  assert.equal(second.events.filter((e) => e.type === "evalGraded").length, 2);
  assert.ok(f.calls.every((c) => c.contextID === `run-${first.runID}`));
  assert.ok(f.calls.every((c) => c.persistContext));
});

test("invalid finish fails an eval without repair or executable grading", async (t) => {
  const f = await fixture(t, () => ({
    toolCalls: [
      { callID: "invalid", name: "finish", arguments: '{"wrong":true}' },
    ],
  }));
  const r = await f.submit({
    ...seed(),
    grader: {
      schema: finishSchema,
      exec: {
        executablePath: process.execPath,
        argv: [
          "-e",
          `require('fs').writeFileSync(${JSON.stringify(f.marker)},'graded')`,
        ],
      },
    },
  });
  assert.equal(r.state, "failed");
  assert.equal(r.evaluation!.grade.status, "failed");
  assert.equal(f.calls.length, 1);
  assert.equal(r.evaluation!.grade.exec, undefined);
  await assert.rejects(access(f.marker));
});
