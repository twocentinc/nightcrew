import { settings, agentDraft, compactionFixture } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { Service } from "../dist/engine/service.js";
import { manage as rawmanage } from "../dist/utils/commands/management.js";
const manage: (...args: Parameters<typeof rawmanage>) => Promise<any> =
  rawmanage;
import {
  operations,
  callOperation as rawcallOperation,
} from "../dist/utils/commands/operations.js";
const callOperation: (
  ...args: Parameters<typeof rawcallOperation>
) => Promise<any> = rawcallOperation;
import {
  outputValidationSchema,
  runOutcome,
  loopProblem,
} from "../dist/engine/supervision.js";
import { validateSummaryEvidence } from "../dist/engine/compaction/evidence.js";
import { compactionInstructions } from "../dist/engine/compaction/format.js";
const input = () => ({
  messageID: randomUUID(),
  content: "perform the task",
  attachments: [],
});
const validation = {
  validator: {
    type: "json-schema" as const,
    schema: {
      type: "object" as const,
      properties: { answer: { type: "number" as const } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
};
test("output validation rejects the removed repairAttempts option", () => {
  assert.equal(outputValidationSchema.safeParse(validation).success, true);
  assert.equal(
    outputValidationSchema.safeParse({ ...validation, repairAttempts: 1 })
      .success,
    false,
  );
});
async function until(fn?: any) {
  for (let i = 0; i < 500; i++) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw Error("timeout");
}
async function fixture(
  t: import("node:test").TestContext,
  generate?: any,
  extra = {},
  hooks: any[] = [],
) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-supervision-"));
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      models: [
        {
          modelID: "q",
          kind: "chat" as const,
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
    }),
  );
  const calls: any[] = [];
  const runtime = {
    status: () => [],
    close: async () => {},
    generate: async (
      request?: any,
      signal?: any,
      onDelta?: any,
      onEvidence?: any,
    ) => {
      calls.push(request);
      return {
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(await generate(request, calls.length, signal, {
          onDelta,
          onEvidence,
        })),
      };
    },
  };
  let service!: Service;
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
  await service.createAgent(
    agentDraft.parse({
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
    }),
  );
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
test("invalid output fails immediately, retains evidence, and never dispatches completed delivery", async (t) => {
  const f = await fixture(
    t,
    async () => ({ text: "bad JSON" }),
    { outputValidation: validation },
    [
      {
        hookID: "delivery",
        event: "run.completed",
        purpose: "delivery",
        executablePath: "/does-not-exist",
        timeoutMs: 100,
      },
    ],
  );
  const r = await f.submit();
  assert.equal(r.state, "failed");
  assert.equal(r.result, null);
  assert.equal(f.calls.length, 1);
  assert.equal(r.error.code, "output_validation_failed");
  assert.deepEqual(
    r.validations.map((v: any) => v.status),
    ["failed"],
  );
  assert.ok(
    r.messages.some(
      (m: any) => m.role === "assistant" && m.content === "bad JSON",
    ),
  );
  assert.equal(r.hookReceipts.length, 0);
  assert.equal(f.service.detail(r).outcome.output, "failed");
  await f.restart();
  const restored = await f.service.run(r.runID);
  assert.equal(restored.state, "failed");
  assert.equal(f.calls.length, 1);
  const fleet = await callOperation(f.service, { command: "status" });
  assert.equal(fleet.totals.needsAttention, 1);
  operations["status"].result.parse(fleet);
});
test("unconfigured output is unverified and ordinary hooks are not deliveries", async (t) => {
  const f = await fixture(t, async () => ({ text: "done" }), {}, [
    {
      hookID: "test-hook",
      event: "run.completed",
      executablePath: "/does-not-exist",
      timeoutMs: 100,
    },
  ]);
  const r = await f.submit();
  const settled = await until(async () => {
    const x = await f.service.run(r.runID);
    return x.hookReceipts.some((h?: any) => h.status === "failed") && x;
  });
  const o = runOutcome(settled);
  assert.equal(o.output, "notConfigured");
  assert.equal(o.delivery, "notConfigured");
  assert.equal(o.hooks, "failed");
  assert.equal(o.task, "needsAttention");
});
test("validator hooks run once and process failures fail the run", async (t) => {
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
            type: "hook" as const,
            executablePath: executable,
            argv: [],
            timeoutMs: 1000,
          },
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
            type: "hook" as const,
            executablePath: "/not-installed",
            argv: [],
            timeoutMs: 100,
          },
        },
      },
    },
  });
  r = await f.submit();
  assert.equal(r.validations[0].status, "error");
  assert.equal(r.state, "failed");
  assert.equal(r.validations.length, 1);
  assert.equal(f.calls.length, 2);
});
test("loop errors get one recovery opportunity then tool-free finalization with failure evidence", async (t) => {
  const f = await fixture(
    t,
    async (request?: any, n?: any) =>
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
  assert.equal(runOutcome(r).needsAttention, true);
  assert.equal(r.messages.filter((m?: any) => m.role === "tool").length, 3);
});
test("explicit persistent follow-up can succeed while retaining the prior failure", async (t) => {
  const f = await fixture(
    t,
    async (_?: any, n?: any) => ({ text: n % 2 ? "invalid" : '{"answer":1}' }),
    { outputValidation: validation, contextMode: "persistent" },
  );
  const first = await f.submit();
  const second = await f.submit();
  assert.equal(first.runID, second.runID);
  assert.notEqual(second.turnID, first.turnID);
  assert.equal(first.state, "failed");
  assert.equal(second.state, "completed");
  assert.equal(second.validations.length, 2);
  assert.equal(runOutcome(second).output, "passed");
  assert.equal(f.calls.length, 2);
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
    compactionFixture(request),
  );
  assert.throws(
    () =>
      validateSummaryEvidence(
        "98% approved (215/217)",
        compactionFixture(request),
      ),
    /unsupported numeric/,
  );
  assert.throws(
    () =>
      validateSummaryEvidence("evidence-deadbeef", compactionFixture(request)),
    /unknown evidence/,
  );
  assert.match(compactionInstructions, /unverified hypotheses/);
  assert.match(compactionInstructions, /remaining work/);
  assert.match(compactionInstructions, /units/);
});

test("unchanged successful calls stop after the single recovery opportunity", async (t) => {
  const f = await fixture(
    t,
    async (request?: any) =>
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
  assert.equal(r.messages.filter((m?: any) => m.role === "tool").length, 4);
});

test("failed runs retry in place with a new turnID and preserved failure evidence", async (t) => {
  const f = await fixture(t, async (_?: any, n?: any) => {
    if (n === 1) throw Error("fixture generation failure");
    return { text: "recovered" };
  });
  const failed = await f.submit();
  assert.equal(failed.state, "failed");
  const request = {
    expectedRevision: failed.revision,
    messageID: randomUUID(),
    note: "Runtime repaired.",
  };
  const dry = await callOperation(f.service, {
    command: "runs retry",
    resourceID: failed.runID,
    request,
    dryRun: true,
  });
  assert.equal((await f.service.run(failed.runID)).state, "failed");
  await callOperation(f.service, {
    command: "runs retry",
    resourceID: failed.runID,
    request,
    yes: true,
  });
  const done = await until(async () => {
    const r = await f.service.run(failed.runID);
    return r.state === "completed" && r;
  });
  assert.notEqual(done.turnID, failed.turnID);
  assert.equal(done.result, "recovered");
  assert.deepEqual(
    done.attempts.slice(0, failed.attempts.length),
    failed.attempts,
  );
  assert.deepEqual(done.events.slice(0, failed.events.length), failed.events);
  assert.equal(
    done.messages.filter((m?: any) => m.messageID === request.messageID).length,
    1,
  );
  assert.equal(dry.runID, done.runID);
});

test("output-limit chunks form one validated JSON answer and remain inspectable", async (t) => {
  const f = await fixture(
    t,
    async (request?: any, n?: any) => {
      assert.equal(request.continueOnOutputLimit, true);
      if (n === 1) return { text: '{"answer":', outputLimitReached: true };
      assert.equal(request.continueFinalMessage, true);
      assert.equal(request.messages.at(-1).role, "assistant");
      assert.equal(request.messages.at(-1).content, '{"answer":');
      assert.deepEqual(request.tools, []);
      return { text: "42}" };
    },
    { outputValidation: validation },
  );
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(r.result, '{"answer":42}');
  assert.equal(r.validations.length, 1);
  assert.equal(r.validations[0].status, "passed");
  assert.equal(
    r.messages.filter((m?: any) => m.role === "assistant").length,
    1,
  );
  assert.equal(r.attempts[0].reason, "output_limit");
  assert.equal(r.attempts[0].text, '{"answer":');
  assert.equal(r.attempts[0].messageID, r.messages.at(-1).messageID);
  const { verifyRun } = await import("../dist/storage/artifacts.js");
  assert.equal((await verifyRun(f.service, r.runID)).valid, true);
});

test("multiple output chunks survive an interrupted continuation and daemon restart", async (t) => {
  const f = await fixture(t, async (request?: any, n?: any, signal?: any) => {
    if (n === 1) return { text: "first ", outputLimitReached: true };
    if (n === 2) return { text: "second ", outputLimitReached: true };
    if (n === 3) {
      await new Promise<any>((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      throw Error("interrupted");
    }
    assert.equal(request.messages.at(-1).content, "first second ");
    return { text: "last" };
  });
  const accepted = await f.service.submit("worker", input());
  await until(() => f.calls.length === 3);
  await f.restart();
  const r = await until(async () => {
    const r = await f.service.run(accepted.runID);
    return r.state === "completed" && r;
  });
  assert.equal(r.result, "first second last");
  assert.equal(
    r.attempts.filter((a?: any) => a.reason === "output_limit").length,
    2,
  );
  assert.equal(
    r.messages.filter((m?: any) => m.role === "assistant").length,
    1,
  );
});

test("truncated tool calls are regenerated, never executed as fragments", async (t) => {
  const f = await fixture(
    t,
    async (request?: any, n?: any, signal?: any, evidence?: any) => {
      if (n === 1) {
        evidence.onEvidence({
          reasoningContent: "",
          toolCalls: [
            {
              index: 0,
              callID: "partial",
              name: "runs_list",
              arguments: '{"limit":',
            },
          ],
        });
        return { text: "", outputLimitReached: true };
      }
      if (n === 2) {
        assert.equal(
          request.messages.filter((m?: any) => m.role === "tool").length,
          0,
        );
        assert.match(request.messages.at(-1).content, /NOT executed/);
        assert(
          request.tools.some(
            (t: import("node:test").TestContext) => t.name === "runs_list",
          ),
        );
        return {
          text: "",
          toolCalls: [
            { callID: "complete", name: "runs_list", arguments: '{"limit":1}' },
          ],
        };
      }
      return { text: "done" };
    },
    { mode: "agent-loop", toolIDs: ["runs_list"] },
  );
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.deepEqual(
    r.messages
      .filter((m?: any) => m.role === "tool")
      .map((m?: any) => m.toolCallID),
    ["complete"],
  );
});

test("thinking-only output limits retain reasoning and request a visible answer", async (t) => {
  const f = await fixture(
    t,
    async (request?: any, n?: any) => {
      if (n === 1)
        return {
          text: "",
          reasoningContent: "Unfinished hypothesis",
          outputLimitReached: true,
        };
      assert.equal(request.thinking, false);
      assert.match(request.messages.at(-2).content, /Unfinished hypothesis/);
      return { text: "qualified answer" };
    },
    { thinking: true },
  );
  const r = await f.submit();
  assert.equal(r.result, "qualified answer");
  assert.equal(r.messages.at(-1).reasoningContent, "Unfinished hypothesis");
});

test("empty length responses cannot spin through continuation forever", async (t) => {
  const f = await fixture(t, async () => ({
    text: "",
    outputLimitReached: true,
  }));
  const r = await f.submit();
  assert.equal(r.state, "failed");
  assert.match(r.error.message, /no progress/);
  assert.equal(f.calls.length, 1);
});

test("hook identity survives path changes and retry uses receipt UUID", async (t) => {
  const f = await fixture(t, async () => ({}), {}, [
    {
      hookID: "deliver",
      purpose: "delivery",
      event: "run.completed",
      executablePath: "/usr/bin/false",
      timeoutMs: 1000,
    },
  ]);
  const submitted = await f.submit();
  let run = await until(async () => {
    const r = await f.service.run(submitted.runID);
    return r.hookReceipts[0]?.status === "failed" && r;
  });
  const original = run.hookReceipts[0];
  assert.ok(original.startedAt && original.finishedAt);
  const config = structuredClone(f.service.storage.store);
  config.config.hooks[0]!.executablePath = "/usr/bin/true";
  await f.service.storage.exclusive(() => f.service.storage.saveConfig(config));
  f.service["hooks"].scheduleHooks(run);
  await f.service["hooks"].drain();
  run = await f.service.run(run.runID);
  assert.equal(
    run.hookReceipts.length,
    1,
    "moving the executable must not replay a dispatched event",
  );
  const input = {
    expectedRevision: run.revision,
    receiptID: original.receiptID,
    requestID: randomUUID(),
    note: "verified safe to retry",
    acceptUnknown: false,
  };
  await f.service.retryHook(run.runID, input, false);
  run = await f.service.run(run.runID);
  assert.equal(run.hookReceipts[1].status, "succeeded");
  assert.equal(run.hookReceipts[1].retryOfReceiptID, original.receiptID);
  assert.equal(run.hookReceipts[1].hookID, "deliver");
  assert.equal(run.events.at(-1).data.receiptID, run.hookReceipts[1].receiptID);
  await f.service.retryHook(run.runID, input, false);
  await f.restart();
  assert.equal((await f.service.run(run.runID)).hookReceipts.length, 2);
});
