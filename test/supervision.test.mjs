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
    generate: async (request, signal, onDelta, onEvidence) => {
      calls.push(request);
      return {
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(await generate(request, calls.length, signal, { onDelta, onEvidence })),
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
  for (const call of f.calls) {
    assert.equal(call.messages[0].role, "system");
    assert.equal(call.messages.filter((m) => m.role === "system").length, 1);
    assert.match(call.messages[0].content, /Final output must be JSON/);
  }
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
  const fleet = await callOperation(f.service, { command: "status" });
  assert.equal(fleet.totals.needsReview, 1);
  assert.equal(fleet.agents[0].latestRun.runID, r.runID);
  assert.equal(fleet.review[0].outcome.output, "failed");
  operations["status"].result.parse(fleet);
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

test("review notes resolve attention without changing evidence and reopen on new failures", async (t) => {
  const f = await fixture(t, async () => ({ text: "bad" }), {
    outputValidation: validation,
  });
  const r = await f.submit();
  const request = {
    expectedRevision: r.revision,
    status: "resolved",
    note: "Inspected the failed output; no action required.",
  };
  const dry = await callOperation(f.service, {
    command: "runs review",
    resourceID: r.runID,
    request,
    dryRun: true,
  });
  assert.equal(dry.changed, false);
  assert.equal((await f.service.run(r.runID)).reviews.length, 0);
  const reviewed = await callOperation(f.service, {
    command: "runs review",
    resourceID: r.runID,
    request,
  });
  assert.equal(reviewed.run.outcome.needsReview, false);
  assert.equal(reviewed.run.outcome.output, "failed");
  assert.equal(reviewed.run.outcome.task, "reviewed");
  await assert.rejects(
    callOperation(f.service, {
      command: "runs review",
      resourceID: r.runID,
      request,
    }),
    /revision_conflict/,
  );
  await f.restart();
  assert.equal(runOutcome(await f.service.run(r.runID)).review, "resolved");
  const current = await f.service.run(r.runID);
  const retry = {
    expectedRevision: current.revision,
    messageID: randomUUID(),
    note: "Try the input again.",
  };
  await assert.rejects(
    callOperation(f.service, {
      command: "runs retry",
      resourceID: r.runID,
      request: retry,
    }),
    /confirmation/i,
  );
  const accepted = await callOperation(f.service, {
    command: "runs retry",
    resourceID: r.runID,
    request: retry,
    yes: true,
  });
  assert.equal(accepted.runID, r.runID);
  const next = await until(async () => {
    const x = await f.service.run(r.runID);
    return x.state === "completed" && x.segment === r.segment + 1 && x;
  });
  assert.equal(next.reviews.length, 1);
  assert.equal(runOutcome(next).review, "open");
  assert.deepEqual(next.messages.slice(0, r.messages.length), r.messages);
  const replay = await callOperation(f.service, {
    command: "runs retry",
    resourceID: r.runID,
    request: retry,
    yes: true,
  });
  assert.equal(replay.replayed, true);
  assert.equal((await f.service.run(r.runID)).segment, next.segment);
});

test("hook recovery preserves attempts, deduplicates UUIDs and reconciles outcome", async (t) => {
  const f = await fixture(t, async () => ({ text: "done" }), {}, [
    {
      event: "run.completed",
      executablePath: "/missing-nightcrew-hook",
      timeoutMs: 100,
    },
  ]);
  const r = await f.submit();
  const failed = await until(async () => {
    const x = await f.service.run(r.runID);
    return x.hookReceipts[0]?.status === "failed" && x;
  });
  const executable = path.join(f.home, "recovered-hook");
  const count = path.join(f.home, "hook-count");
  await writeFile(
    executable,
    `#!/bin/sh\ncat >/dev/null\necho called >> '${count}'\n`,
    { mode: 0o700 },
  );
  // Correct the registration, leaving the failed receipt immutable.
  f.service.storage.store.config.hooks[0].executablePath = executable;
  f.service.storage.store.config.hooks[0].timeoutMs = 2000;
  await f.service.storage.saveConfig(f.service.storage.store);
  const request = {
    expectedRevision: failed.revision,
    receiptIndex: 0,
    requestID: randomUUID(),
    note: "Corrected missing executable.",
    hookPath: executable,
  };
  const dry = await callOperation(f.service, {
    command: "runs retry-hook",
    resourceID: r.runID,
    request,
    dryRun: true,
  });
  assert.equal(dry.changed, false);
  const retried = await callOperation(f.service, {
    command: "runs retry-hook",
    resourceID: r.runID,
    request,
    yes: true,
  });
  assert.equal(
    retried.run.outcome.hooks,
    "succeeded",
    JSON.stringify(retried.run.hookReceipts),
  );
  assert.equal(retried.run.outcome.needsReview, false);
  const stored = await f.service.run(r.runID);
  assert.equal(stored.hookReceipts.length, 2);
  assert.deepEqual(stored.hookReceipts[0], failed.hookReceipts[0]);
  assert.equal(stored.hookReceipts[1].retryOf, 0);
  await callOperation(f.service, {
    command: "runs retry-hook",
    resourceID: r.runID,
    request,
    yes: true,
  });
  assert.equal((await readFile(count, "utf8")).trim(), "called");
  await assert.rejects(
    callOperation(f.service, {
      command: "runs retry-hook",
      resourceID: r.runID,
      request: {
        ...request,
        requestID: randomUUID(),
        expectedRevision: stored.revision,
      },
      yes: true,
    }),
    /hook_already_retried/,
  );
});

test("unknown hooks require explicit acceptance and pending attempts become unknown on restart", async (t) => {
  const f = await fixture(t, async () => ({ text: "done" }), {}, [
    {
      event: "run.completed",
      executablePath: "/missing-nightcrew-hook",
      timeoutMs: 100,
    },
  ]);
  const r = await f.submit();
  const failed = await until(async () => {
    const x = await f.service.run(r.runID);
    return x.hookReceipts[0]?.status === "failed" && x;
  });
  failed.hookReceipts[0].status = "pending";
  await f.service.storage.exclusive(() => f.service.storage.write(failed));
  await f.restart();
  const unknown = await f.service.run(r.runID);
  assert.equal(unknown.hookReceipts[0].status, "unknown");
  const request = {
    expectedRevision: unknown.revision,
    receiptIndex: 0,
    requestID: randomUUID(),
    note: "Checked external destination.",
  };
  await assert.rejects(
    callOperation(f.service, {
      command: "runs retry-hook",
      resourceID: r.runID,
      request,
      yes: true,
    }),
    /hook_outcome_unknown/,
  );
  const retried = await callOperation(f.service, {
    command: "runs retry-hook",
    resourceID: r.runID,
    request: { ...request, acceptUnknown: true },
    yes: true,
  });
  assert.equal(retried.run.hookReceipts.length, 2);
  assert.equal(retried.run.outcome.hooks, "failed");
});

test("failed runs retry in place with a new segment and preserved failure evidence", async (t) => {
  const f = await fixture(t, async (_, n) => {
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
  assert.equal(done.segment, failed.segment + 1);
  assert.equal(done.result, "recovered");
  assert.deepEqual(
    done.attempts.slice(0, failed.attempts.length),
    failed.attempts,
  );
  assert.deepEqual(done.events.slice(0, failed.events.length), failed.events);
  assert.equal(
    done.messages.filter((m) => m.messageID === request.messageID).length,
    1,
  );
  assert.equal(dry.runID, done.runID);
});

test("output-limit chunks form one validated JSON answer and remain inspectable", async (t) => {
  const f = await fixture(t, async (request, n) => {
    assert.equal(request.continueOnOutputLimit, true);
    if (n === 1) return { text: '{"answer":', outputLimitReached: true };
    assert.equal(request.continueFinalMessage, true);
    assert.equal(request.messages.at(-1).role, "assistant");
    assert.equal(request.messages.at(-1).content, '{"answer":');
    assert.deepEqual(request.tools, []);
    return { text: '42}' };
  }, { outputValidation: validation });
  const r = await f.submit();
  assert.equal(r.state, 'completed');
  assert.equal(r.result, '{"answer":42}');
  assert.equal(r.validations.length, 1);
  assert.equal(r.validations[0].status, 'passed');
  assert.equal(r.messages.filter(m => m.role === 'assistant').length, 1);
  assert.equal(r.attempts[0].reason, 'output_limit');
  assert.equal(r.attempts[0].text, '{"answer":');
  assert.equal(r.attempts[0].messageID, r.messages.at(-1).messageID);
  const { verifyRun } = await import('../dist/runArtifacts.js');
  assert.equal((await verifyRun(f.service, r.runID)).valid, true);
});

test("multiple output chunks survive an interrupted continuation and daemon restart", async (t) => {
  const f = await fixture(t, async (request, n, signal) => {
    if (n === 1) return { text: 'first ', outputLimitReached: true };
    if (n === 2) return { text: 'second ', outputLimitReached: true };
    if (n === 3) {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
      throw Error('interrupted');
    }
    assert.equal(request.messages.at(-1).content, 'first second ');
    return { text: 'last' };
  });
  const accepted = await f.service.submit('worker', input());
  await until(() => f.calls.length === 3);
  await f.restart();
  const r = await until(async () => {
    const r = await f.service.run(accepted.runID);
    return r.state === 'completed' && r;
  });
  assert.equal(r.result, 'first second last');
  assert.equal(r.attempts.filter(a => a.reason === 'output_limit').length, 2);
  assert.equal(r.messages.filter(m => m.role === 'assistant').length, 1);
});

test("truncated tool calls are regenerated, never executed as fragments", async (t) => {
  const f = await fixture(t, async (request, n, signal, evidence) => {
    if (n === 1) {
      evidence.onEvidence({ reasoningContent: '', toolCalls: [{ index: 0, callID: 'partial', name: 'runs_list', arguments: '{"limit":' }] });
      return { text: '', outputLimitReached: true };
    }
    if (n === 2) {
      assert.equal(request.messages.filter(m => m.role === 'tool').length, 0);
      assert.match(request.messages.at(-1).content, /NOT executed/);
      assert(request.tools.some(t => t.name === 'runs_list'));
      return { text: '', toolCalls: [{ callID: 'complete', name: 'runs_list', arguments: '{"limit":1}' }] };
    }
    return { text: 'done' };
  }, { mode: 'agent-loop', toolIDs: ['runs_list'] });
  const r = await f.submit();
  assert.equal(r.state, 'completed');
  assert.deepEqual(r.messages.filter(m => m.role === 'tool').map(m => m.toolCallID), ['complete']);
});

test("thinking-only output limits retain reasoning and request a visible answer", async (t) => {
  const f = await fixture(t, async (request, n) => {
    if (n === 1) return { text: '', reasoningContent: 'Unfinished hypothesis', outputLimitReached: true };
    assert.equal(request.thinking, false);
    assert.match(request.messages.at(-2).content, /Unfinished hypothesis/);
    return { text: 'qualified answer' };
  }, { thinking: true });
  const r = await f.submit();
  assert.equal(r.result, 'qualified answer');
  assert.equal(r.messages.at(-1).reasoningContent, 'Unfinished hypothesis');
});

test("empty length responses cannot spin through continuation forever", async (t) => {
  const f = await fixture(t, async () => ({ text: '', outputLimitReached: true }));
  const r = await f.submit();
  assert.equal(r.state, 'failed');
  assert.match(r.error.message, /no progress/);
  assert.equal(f.calls.length, 1);
});
