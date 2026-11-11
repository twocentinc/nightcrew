import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Storage, initializeHome } from "../dist/storage.js";
import { Service } from "../dist/service.js";
import { manage } from "../dist/management.js";
import { operations, callOperation } from "../dist/operations.js";
import { runOutcome, loopProblem } from "../dist/supervision.js";
import {
  validateSummaryEvidence,
  compactionInstructions,
} from "../dist/compaction.js";
const input = () => ({
  messageID: randomUUID(),
  content: "perform the task",
  attachments: [],
});
const validation = {
  validator: {
    type: "json-schema",
    schema: {
      type: "object",
      properties: { answer: { type: "number" } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  repairAttempts: 1,
};
async function until(fn) {
  for (let i = 0; i < 500; i++) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw Error("timeout");
}
async function fixture(t, generate, extra = {}, hooks = []) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-supervision-"));
  await initializeHome(home, {
    host: "127.0.0.1",
    port: 6970,
    interactionCooldownMs: 0,
    models: [
      {
        modelID: "q",
        kind: "chat",
        weightsPath: "/unused",
        projectorPath: null,
        idleUnloadMs: 0,
      },
    ],
    slots: [
      {
        slotID: "instant",
        modelID: "q",
        index: 0,
        contextTokens: 4096,
        instant: true,
      },
    ],
    hooks,
  });
  const calls = [];
  const runtime = {
    status: () => [],
    close: async () => {},
    generate: async (request, signal) => {
      calls.push(request);
      return {
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(await generate(request, calls.length, signal)),
      };
    },
  };
  let service;
  const start = async () => {
    service = new Service(new Storage(home), runtime, async () => ({
      state: "away",
      reason: "test",
      samplingHealthy: true,
      observedAt: new Date().toISOString(),
      diagnostic: null,
    }));
    await service.initialize();
  };
  await start();
  t.after(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  await service.createAgent({
    agentID: "worker",
    name: "worker",
    systemPrompt: "Return the requested result.",
    mode: "single-turn",
    modelID: "q",
    slotID: "instant",
    skillIDs: [],
    toolIDs: [],
    enabled: true,
    timeoutMs: 30000,
    thinking: false,
    maxOutputTokens: 128,
    ...extra,
  });
  const submit = async () => {
    const a = await service.submit("worker", input());
    return until(async () => {
      const r = await service.run(a.runID);
      return ["completed", "failed", "timedOut"].includes(r.state) && r;
    });
  };
  return {
    home,
    calls,
    submit,
    get service() {
      return service;
    },
    restart: async () => {
      await service.close();
      await start();
    },
  };
}
test("output repair preserves original answer, disables tools and thinking, persists verdicts", async (t) => {
  const f = await fixture(
    t,
    async (_, n) => ({ text: n === 1 ? "bad JSON" : '{"answer":42}' }),
    { outputValidation: validation },
  );
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(r.result, '{"answer":42}');
  assert.equal(
    r.messages.filter((m) => m.role === "assistant")[0].content,
    "bad JSON",
  );
  assert.deepEqual(
    r.validations.map((v) => v.status),
    ["failed", "passed"],
  );
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].thinking, false);
  assert.deepEqual(f.calls[1].tools, []);
  assert.equal(f.service.detail(r).outcome.task, "validated");
  await f.restart();
  const restored = await f.service.run(r.runID);
  assert.equal(restored.validations.length, 2);
  assert.equal(f.service.detail(restored).outcome.output, "passed");
});
test("bounded failed repairs complete execution but mark output for review and suppress delivery", async (t) => {
  const f = await fixture(
    t,
    async () => ({ text: "invalid" }),
    { outputValidation: validation },
    [
      {
        event: "run.completed",
        purpose: "delivery",
        executablePath: "/does-not-exist",
        timeoutMs: 100,
      },
    ],
  );
  const r = await f.submit();
  assert.equal(f.calls.length, 2);
  assert.equal(r.state, "completed");
  assert.equal(r.validations.length, 2);
  const settled = await until(async () => {
    const x = await f.service.run(r.runID);
    return x.hookReceipts.length && x;
  });
  const o = f.service.detail(settled).outcome;
  assert.equal(o.output, "failed");
  assert.equal(o.task, "needsReview");
  assert.equal(o.delivery, "failed");
  assert.match(settled.hookReceipts[0].diagnostic, /not dispatched/);
  const fleet = await callOperation(f.service, { command: "fleet status" });
  assert.equal(fleet.totals.needsReview, 1);
  assert.equal(fleet.agents[0].latestRun.runID, r.runID);
  assert.equal(fleet.review[0].outcome.output, "failed");
  operations["fleet status"].result.parse(fleet);
});
test("unconfigured output is unverified and ordinary hooks are not deliveries", async (t) => {
  const f = await fixture(t, async () => ({ text: "done" }), {}, [
    {
      event: "run.completed",
      executablePath: "/does-not-exist",
      timeoutMs: 100,
    },
  ]);
  const r = await f.submit();
  const settled = await until(async () => {
    const x = await f.service.run(r.runID);
    return x.hookReceipts.some((h) => h.status === "failed") && x;
  });
  const o = runOutcome(settled);
  assert.equal(o.output, "notConfigured");
  assert.equal(o.delivery, "notConfigured");
  assert.equal(o.hooks, "failed");
  assert.equal(o.task, "needsReview");
});
test("validator hook verdicts use bounded repair; hook process failures do not retry", async (t) => {
  const f = await fixture(t, async () => ({ text: "answer" }));
  const executable = path.join(f.home, "validator");
  await writeFile(
    executable,
    `#!${process.execPath}\nlet text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>console.log(JSON.stringify({valid:JSON.parse(text).text==='answer',reason:'checked'})));\n`,
    { mode: 0o700 },
  );
  let agent = f.service.agent("worker");
  await manage(f.service, {
    command: "agents update",
    resourceID: "worker",
    request: {
      expectedRevision: agent.revision,
      changes: {
        outputValidation: {
          validator: {
            type: "hook",
            executablePath: executable,
            argv: [],
            timeoutMs: 1000,
          },
          repairAttempts: 1,
        },
      },
    },
  });
  let r = await f.submit();
  assert.equal(r.validations[0].status, "passed");
  agent = f.service.agent("worker");
  await manage(f.service, {
    command: "agents update",
    resourceID: "worker",
    request: {
      expectedRevision: agent.revision,
      changes: {
        outputValidation: {
          validator: {
            type: "hook",
            executablePath: "/not-installed",
            argv: [],
            timeoutMs: 100,
          },
          repairAttempts: 2,
        },
      },
    },
  });
  r = await f.submit();
  assert.equal(r.validations[0].status, "error");
  assert.equal(r.validations.length, 1);
  assert.equal(f.calls.length, 2);
});
test("loop errors get one recovery opportunity then tool-free finalization with failure evidence", async (t) => {
  const f = await fixture(
    t,
    async (request, n) =>
      request.tools.length
        ? {
            text: "",
            toolCalls: [
              { callID: randomUUID(), name: "nonexistent", arguments: "{}" },
            ],
          }
        : { text: "Could not retrieve evidence." },
    {
      mode: "agent-loop",
      loopPolicy: { consecutiveErrors: 2, repeatedCalls: 2 },
      maxToolCalls: 20,
    },
  );
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(r.recovery.finalizing, true);
  assert.equal(f.calls.length, 4);
  assert.match(f.calls[2].messages.at(-1).content, /recovery opportunity/);
  assert.deepEqual(f.calls[3].tools, []);
  assert.equal(runOutcome(r).needsReview, true);
  assert.equal(r.messages.filter((m) => m.role === "tool").length, 3);
});
test("persistent follow-up gets its own repair budget and retains old evidence", async (t) => {
  const f = await fixture(
    t,
    async (_, n) => ({ text: n % 2 ? "invalid" : '{"answer":1}' }),
    { outputValidation: validation, contextMode: "persistent" },
  );
  const first = await f.submit();
  const second = await f.submit();
  assert.equal(first.runID, second.runID);
  assert.equal(second.segment, 1);
  assert.equal(second.validations.length, 4);
  assert.equal(runOutcome(second).output, "passed");
  assert.equal(f.calls.length, 4);
});
test("compaction guard rejects invented quantities and evidence IDs, retains uncertainty and units", () => {
  const request = {
    previousSummary: null,
    messages: [
      {
        content:
          "Unverified hypothesis: 215 of 238 scanned rows approved; 21 pending, 2 rejected. Rent is 1800 USD/month, not total spending. evidence-abc123. Still need a comparison group.",
      },
    ],
  };
  validateSummaryEvidence(
    "Unverified hypothesis; 215 of 238 scanned rows approved. Rent 1800 USD/month. evidence-abc123. Still need a comparison group.",
    request,
  );
  assert.throws(
    () => validateSummaryEvidence("98% approved (215/217)", request),
    /unsupported numeric/,
  );
  assert.throws(
    () => validateSummaryEvidence("evidence-deadbeef", request),
    /unknown evidence/,
  );
  assert.match(compactionInstructions, /unverified hypotheses/);
  assert.match(compactionInstructions, /remaining work/);
  assert.match(compactionInstructions, /units/);
});

test("unchanged successful calls stop after the single recovery opportunity", async (t) => {
  const f = await fixture(
    t,
    async (request) =>
      request.tools.length
        ? {
            text: "",
            toolCalls: [
              { callID: randomUUID(), name: "load_skills", arguments: "{}" },
            ],
          }
        : { text: "No further progress." },
    {
      mode: "agent-loop",
      loopPolicy: { consecutiveErrors: 3, repeatedCalls: 3 },
      maxToolCalls: 20,
    },
  );
  const r = await f.submit();
  assert.equal(f.calls.length, 5);
  assert.equal(r.recovery.finalizing, true);
  assert.equal(r.messages.filter((m) => m.role === "tool").length, 4);
});
