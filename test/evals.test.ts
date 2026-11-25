import { settings, agentDraft } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  chmod,
  rm,
  access,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import {evalSuiteSchema} from "../dist/engine/evals/format.js";
import {runEval as rawRunEval} from "../dist/engine/evals/runner.js";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { Service } from "../dist/engine/service.js";
import { callOperation as rawcallOperation } from "../dist/commands/operations.js";
const callOperation: (
  ...args: Parameters<typeof rawcallOperation>
) => Promise<any> = rawcallOperation;
import { normalizeError } from "../dist/engine/protocol.js";
const runEval: (...args: Parameters<typeof rawRunEval>) => Promise<any> =
  rawRunEval;
const suite = (): any => ({
  format: "nightcrew.eval",
  version: 1,
  suiteID: "retry",
  agent: { agentID: "reviewer" },
  limits: { maxToolCalls: 4, maxOutputTokens: 64, timeoutMs: 5000 },
  cases: [
    {
      caseID: "retry",
      context: {
        messages: [
          {
            role: "user" as const,
            content:
              "Read the record. Retry one transient error. Return its exact code.",
          },
        ],
      },
      mocks: [
        {
          mockID: "read",
          tool: "inspect",
          arguments: { page: 0 },
          responses: [
            { type: "error" as const, message: "temporary" },
            { type: "result" as const, content: "code: AZ-41" },
          ],
        },
      ],
      expectations: {
        assertions: [
          {
            assertionID: "answer",
            type: "finalContains" as const,
            text: "AZ-41",
          },
          {
            assertionID: "twice",
            type: "mockCallCount" as const,
            mockID: "read",
            min: 2,
            max: 2,
          },
        ],
        criteria: [
          {
            criterionID: "honest",
            description: "JUDGE_ONLY_SENTINEL: do not invent another code",
            severity: "critical",
          },
        ],
      },
    },
  ],
});
const call = (home: string, args: string[], request?: any) =>
  new Promise<any>((resolve, reject) => {
    const p = spawn(
      process.execPath,
      [
        new URL("../dist/cli.js", import.meta.url).pathname,
        ...args,
        "--home",
        home,
        "--request",
        "-",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    p.stdout.on("data", (c) => (out += c));
    p.stderr.on("data", (c) => (err += c));
    p.on("error", reject);
    p.on("close", (code) => {
      try {
        resolve({ code, ...JSON.parse(out) });
      } catch {
        reject(Error(out + err));
      }
    });
    p.stdin.end(JSON.stringify(request));
  });
async function fixture(t: import("node:test").TestContext, override?: any) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-eval-"));
  const inputs: any[] = [];
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      scheduler: { instantModelID: "qwen", contextTokens: 2048 },
      models: [
        {
          modelID: "qwen",
          kind: "chat" as const,
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 1000,
        },
      ],
      slots: [],
      hooks: [],
    }),
  );
  const runtime = {
    status: () => [],
    close: async () => {},
    countTokens: async () => 20,
    generate: async (input?: any) => {
      inputs.push(structuredClone(input));
      if (override) return override(input);
      const results = input.messages.filter((m?: any) => m.role === "tool");
      return {
        text: results.length < 2 ? "" : "AZ-41",
        toolCalls:
          results.length < 2
            ? [
                {
                  callID: randomUUID(),
                  name: "inspect",
                  arguments: '{"page":0}',
                },
              ]
            : [],
        usage: { inputTokens: 12, outputTokens: 3 },
      };
    },
  };
  const service = new Service(new Storage(home), runtime, async () => ({
    state: "present",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  }));
  await service.initialize();
  service.tools.set("inspect", {
    toolID: "inspect",
    description: "Read a record",
    parameters: {
      type: "object" as const,
      properties: { page: { type: "integer" as const } },
      required: ["page"],
      additionalProperties: false,
    },
    executablePath: "/must-never-execute",
    argv: [],
    timeoutMs: 100,
  });
  await service.createAgent(
    agentDraft.parse({
      agentID: "reviewer",
      name: "reviewer",
      systemPrompt: "Follow the user request.",
      modelID: "qwen",
      mode: "agent-loop",
      skillIDs: [],
      toolIDs: ["inspect"],
      enabled: false,
      thinking: false,
      maxOutputTokens: 64,
      timeoutMs: 5000,
      sampling: { topP: 0.8 },
    }),
  );
  const transport = (
    command: string,
    request: unknown = {},
    resourceID: string | undefined = undefined,
  ) =>
    callOperation(service, {
      command,
      request,
      ...(resourceID ? { resourceID } : {}),
    });
  const server = createServer((socket) => {
    let buf = "";
    socket.on("data", async (chunk) => {
      buf += chunk;
      if (!buf.includes("\n")) return;
      const input = JSON.parse(buf.split("\n")[0]);
      buf = "";
      try {
        socket.end(
          JSON.stringify({
            ok: true,
            result: await callOperation(service, input),
          }) + "\n",
        );
      } catch (e) {
        socket.end(
          JSON.stringify({ ok: false, error: normalizeError(e, false) }) + "\n",
        );
      }
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(path.join(home, "control.sock"), resolve),
  );
  await chmod(path.join(home, "control.sock"), 0o600);
  t.after(async () => {
    await new Promise<any>((resolve) => server.close(resolve));
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  return { home, service, inputs, transport, runtime };
}
test("eval schema rejects ambiguous mocks, orphan history, extra keys and invalid assertions", () => {
  const s = suite();
  assert.ok(evalSuiteSchema.safeParse(s).success);
  const duplicate = structuredClone(s);
  duplicate.cases[0].mocks.push({
    ...duplicate.cases[0].mocks[0],
    mockID: "duplicate",
  });
  assert.equal(evalSuiteSchema.safeParse(duplicate).success, false);
  const orphan = structuredClone(s);
  orphan.cases[0].context.messages = [
    { role: "tool" as const, content: "fake", toolCallID: "absent" },
  ];
  assert.equal(evalSuiteSchema.safeParse(orphan).success, false);
  const invalid = structuredClone(s);
  invalid.cases[0].expectations.assertions[1].min = 3;
  assert.equal(evalSuiteSchema.safeParse(invalid).success, false);
  assert.equal(
    evalSuiteSchema.safeParse({ ...s, executeRealTools: true }).success,
    false,
  );
});
test("CLI validates offline and reports invalid input in JSON", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nc-eval-validation-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal(
    (await call(home, ["evals", "validate"], suite())).result.valid,
    true,
  );
  const bad = await call(home, ["evals", "validate"], {
    ...suite(),
    version: 2,
  });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 2);
});
test("CLI runs agent loop, mocks retries, hides rubric, snapshots sampling and saves review-required artifact", async (t) => {
  const f = await fixture(t);
  const destination = path.join(f.home, "eval-result");
  const dry = await call(f.home, ["evals", "run", "--dry-run"], {
    suite: suite(),
    destination,
  });
  assert.equal(dry.ok, true);
  assert.equal(f.inputs.length, 0);
  await assert.rejects(access(destination));
  const out = await call(f.home, ["evals", "run"], {
    suite: suite(),
    destination,
  });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.result.status, "needs_review");
  const saved = JSON.parse(
    (await readFile(path.join(destination, "result.json"), "utf8")).toString(),
  );
  assert.equal(saved.cases[0].counts.read, 2);
  assert.ok(saved.cases[0].assertions.every((a?: any) => a.passed));
  assert.equal(saved.cases[0].criteria[0].status, "unreviewed");
  assert.equal(f.inputs.length, 3);
  assert.equal(f.service.chats.size, 0);
  assert.ok(!JSON.stringify(f.inputs).includes("JUDGE_ONLY_SENTINEL"));
  assert.equal(f.inputs[0].sampling.topP, 0.8);
  assert.equal(
    saved.snapshot.tools.some(
      (t: import("node:test").TestContext) => "executablePath" in t,
    ),
    false,
  );
  const again = await call(f.home, ["evals", "run"], {
    suite: suite(),
    destination,
  });
  assert.equal(again.ok, false);
  assert.equal(f.inputs.length, 3);
});
test("unexpected arguments stop eval without tool execution and preserve attempted call", async (t) => {
  const f = await fixture(t, async () => ({
    text: "",
    toolCalls: [
      { callID: "unexpected", name: "inspect", arguments: '{"page":9}' },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const out = await runEval(
    { suite: suite(), destination: path.join(f.home, "mismatch") },
    f.transport,
  );
  assert.equal(out.status, "failed");
  assert.match(out.cases[0].error, /fixture_mismatch/);
  assert.equal(f.inputs.length, 1);
  const saved = JSON.parse((await readFile(out.resultFile, "utf8")).toString());
  assert.equal(
    saved.cases[0].messages.at(-1).toolCalls[0].arguments,
    '{"page":9}',
  );
});
test("eval sample never executes reserved load_skills and checks context before generation", async (t) => {
  const f = await fixture(t, async () => ({
    text: "",
    toolCalls: [
      {
        callID: "skill",
        name: "load_skills",
        arguments: '{"skillIDs":["nonexistent"]}',
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const s = suite();
  s.cases[0].mocks = [
    {
      mockID: "skill",
      tool: "load_skills",
      arguments: { skillIDs: ["nonexistent"] },
      responses: [{ type: "result" as const, content: "fixture instructions" }],
    },
  ];
  s.limits.maxToolCalls = 1;
  s.cases[0].expectations.assertions = [];
  const out = await runEval(
    { suite: s, destination: path.join(f.home, "reserved") },
    f.transport,
  );
  assert.equal(out.cases[0].error, "tool_budget");
  assert.equal(f.inputs[1].messages.at(-1).content, "fixture instructions");
  f.runtime.countTokens = async () => 999999;
  const before = f.inputs.length;
  const overflow = await runEval(
    { suite: s, destination: path.join(f.home, "overflow") },
    f.transport,
  );
  assert.equal(overflow.cases[0].error, "context_full");
  assert.equal(f.inputs.length, before);
});
test("tool-free cases expose no tools; deterministic failures differ from fixture errors", async (t) => {
  const f = await fixture(t, async () => ({
    text: "WRONG",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const s = suite();
  s.cases[0].mocks = [];
  s.cases[0].expectations.assertions = s.cases[0].expectations.assertions.slice(
    0,
    1,
  );
  const out = await runEval(
    { suite: s, destination: path.join(f.home, "wrong") },
    f.transport,
  );
  assert.equal(out.cases[0].status, "failed");
  assert.equal(out.cases[0].error, null);
  assert.deepEqual(f.inputs[0].tools, []);
});
test("fixtures never conflate absent and null arguments", async (t) => {
  const f = await fixture(t, async () => ({
    text: "",
    toolCalls: [
      {
        callID: randomUUID(),
        name: "inspect",
        arguments: '{"page":0,"optional":null}',
      },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  f.service.tools.get("inspect")!.parameters = {
    type: "object" as const,
    properties: {
      page: { type: "integer" as const },
      optional: { type: ["string", "null"] },
    },
    required: ["page"],
    additionalProperties: false,
  };
  const out = await runEval(
    { suite: suite(), destination: path.join(f.home, "null") },
    f.transport,
  );
  assert.match(out.cases[0].error, /unmatched arguments/);
});
test("mock exhaustion is explicit and cannot fall through to an executable", async (t) => {
  const f = await fixture(t, async () => ({
    text: "",
    toolCalls: [
      { callID: randomUUID(), name: "inspect", arguments: '{"page":0}' },
    ],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const s = suite();
  s.cases[0].mocks[0].responses = [
    { type: "result" as const, content: "once" },
  ];
  const out = await runEval(
    { suite: s, destination: path.join(f.home, "exhausted") },
    f.transport,
  );
  assert.match(out.cases[0].error, /exhausted read/);
  assert.equal(f.inputs.length, 2);
});

async function graded(
  t: import("node:test").TestContext,
  source?: any,
  options: { generate?: any; timeoutMs?: number } = {},
) {
  const f = await fixture(t, options.generate);
  const script = path.join(f.home, "grade.ts");
  await writeFile(script, source);
  const s = suite();
  s.graders = [
    {
      graderID: "check",
      executablePath: process.execPath,
      argv: ["--experimental-strip-types", script],
      timeoutMs: options.timeoutMs ?? 2000,
    },
  ];
  return { ...f, script, suite: s };
}
const passingGrade =
  'console.log(JSON.stringify({checks:[{checkID:"semantic",criterionID:"honest",status:"passed",reason:"Checked against the fixture."}]}));';
async function evaluate(f?: any, name = "graded") {
  const out = await runEval(
    { suite: f.suite, destination: path.join(f.home, name) },
    f.transport,
  );
  return {
    out,
    saved: JSON.parse((await readFile(out.resultFile, "utf8")).toString()),
  };
}
test("TypeScript graders receive hidden expectations and complete trace without exposing them to the model", async (t) => {
  const f = await graded(
    t,
    `
    import process from "node:process";
    let data:string="";for await(const chunk of process.stdin)data+=chunk;
    const input=JSON.parse(data);
    if(input.version!==1 || input.result.counts.read!==2 ||
       !JSON.stringify(input.case).includes("JUDGE_ONLY_SENTINEL") ||
       input.result.answer!=="AZ-41")throw Error("Missing evidence");
    ${passingGrade}
  `,
  );
  const dry = await runEval(
    { suite: f.suite, destination: path.join(f.home, "dry") },
    f.transport,
    true,
  );
  assert.equal(f.inputs.length, 0);
  const { out, saved } = await evaluate(f);
  assert.equal(out.status, "passed", JSON.stringify(saved.cases));
  assert.equal(saved.cases[0].criteria[0].status, "passed");
  assert.equal(saved.cases[0].graders[0].status, "completed");
  assert.equal(saved.cases[0].gradingComplete, true);
  assert.equal(saved.snapshot.graders[0].files.length, 2);
  assert.match(saved.snapshot.graders[0].identityHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(f.inputs).includes("JUDGE_ONLY_SENTINEL"));
});
test("dry run never executes graders", async (t) => {
  const f = await graded(t, 'throw Error("MUST_NOT_RUN");');
  const result = await runEval(
    { suite: f.suite, destination: path.join(f.home, "dry") },
    f.transport,
    true,
  );
  assert.equal(f.inputs.length, 0);
  await assert.rejects(access(path.join(f.home, "dry")));
  assert.ok(result.snapshot!.graders.length);
});
test("grader verdicts preserve deterministic failure and execution errors", async (t) => {
  for (const error of [false, true]) {
    const f = await graded(t, passingGrade, {
      generate: async () =>
        error
          ? {
              text: "",
              toolCalls: [
                { callID: "bad", name: "inspect", arguments: '{"page":9}' },
              ],
              usage: { inputTokens: 1, outputTokens: 1 },
            }
          : {
              text: "WRONG",
              toolCalls: [],
              usage: { inputTokens: 1, outputTokens: 1 },
            },
    });
    const { saved } = await evaluate(f);
    assert.equal(saved.cases[0].status, error ? "error" : "failed");
    assert.equal(saved.cases[0].graders[0].status, "completed");
    assert.ok(saved.cases[0].messages.length);
  }
});
test("grader failures, malformed output, duplicate checks, unknown criteria and timeouts are eval errors", async (t) => {
  const scripts = [
    'throw Error("crash");',
    'console.log("not json");',
    "console.log(JSON.stringify({checks:[]}));",
    'console.log(JSON.stringify({checks:[{checkID:"x",status:"passed",reason:"ok"},{checkID:"x",status:"passed",reason:"ok"}]}));',
    'console.log(JSON.stringify({checks:[{checkID:"x",criterionID:"missing",status:"passed",reason:"ok"}]}));',
    "setInterval(()=>{},1000);",
  ];
  for (const source of scripts) {
    const f = await graded(t, source, { timeoutMs: 200 });
    const { out, saved } = await evaluate(f);
    assert.equal(out.status, "failed");
    assert.equal(saved.cases[0].status, "error");
    assert.equal(saved.cases[0].error, "grader_error");
    assert.equal(saved.cases[0].answer, "AZ-41");
    assert.equal(saved.cases[0].graders[0].status, "error");
  }
});
test("a changed grader is rejected before execution", async (t) => {
  let script: any;
  const f = await graded(t, passingGrade, {
    generate: async () => {
      await writeFile(script, 'throw Error("changed executable ran");');
      return {
        text: "AZ-41",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    },
  });
  script = f.script;
  const { saved } = await evaluate(f);
  assert.match(saved.cases[0].graders[0].error, /changed after snapshot/);
});
test("grading conflicts are conservative and unreviewed semantics never pass", async (t) => {
  for (const status of ["failed", "needs_review"]) {
    const f = await graded(t, passingGrade);
    const other = path.join(f.home, "other.ts");
    await writeFile(
      other,
      passingGrade.replace('status:"passed"', 'status:"' + status + '"'),
    );
    f.suite.graders.push({
      ...f.suite.graders[0],
      graderID: "second",
      argv: ["--experimental-strip-types", other],
    });
    const { out, saved } = await evaluate(f);
    assert.equal(out.status, status);
    assert.equal(saved.cases[0].criteria[0].status, status);
  }
  const f = await graded(t, passingGrade.replace('criterionID:"honest",', ""));
  assert.equal((await evaluate(f)).out.status, "needs_review");
});
