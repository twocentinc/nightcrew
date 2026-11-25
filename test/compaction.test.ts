import { runtimeConfig } from "./fixtures.ts";
import { settings, agentDraft, compactionFixture } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Storage, initializeHome } from "../dist/storage.js";
import { Service } from "../dist/service.js";
import { manage as rawmanage } from "../dist/management.js";
const manage: (...args: Parameters<typeof rawmanage>) => Promise<any> =
  rawmanage;
import {
  executeCompactionScript,
  contextMessages,
  validateSummaryEvidence,
} from "../dist/compaction.js";
const message = (content: string) => ({
  messageID: randomUUID(),
  content,
  attachments: [],
});
async function until(fn?: any) {
  for (let i = 0; i < 400; i++) {
    const v = await fn();
    if (v) return v;
    await delay(10);
  }
  throw Error("Timeout");
}
async function fixture(
  t: import("node:test").TestContext,
  handler?: any,
  summary = "Short summary",
  threshold = 400,
) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-compact-"));
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      scheduler: { contextTokens: threshold > 2048 ? 65536 : 2048 },
      models: [
        {
          modelID: "q",
          kind: "chat" as const,
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 300000,
          compactionThresholdTokens: threshold,
        },
      ],
      slots: [],
      hooks: [],
    }),
  );
  const calls: any[] = [];
  let service!: Service;
  const state = { away: true };
  const runtime: {
    generate: (
      input: any,
      ...args: any[]
    ) => Promise<import("../dist/service.js").Result>;
    countTokens: (input: any, ...args: any[]) => Promise<number>;
    close: () => Promise<void>;
    status: () => [];
  } = {
    status: () => [],
    close: async () => {},
    countTokens: async (input?: any) =>
      Math.ceil(
        JSON.stringify(input.messages.map((m?: any) => m.content)).length / 4,
      ) + 10,
    generate: async (input?: any) => {
      calls.push(input);
      return {
        text: input.messages[0].content.includes("Summarize the supplied")
          ? JSON.stringify({ summary })
          : "done",
        toolCalls: [],
        usage: { inputTokens: 10, outputTokens: 10 },
      };
    },
  };
  const start = async () => {
    service = new Service(new Storage(home), runtime, async () => ({
      state: state.away ? "away" : "present",
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
  const agent = async (id: string, extra = {}) =>
    service.createAgent(
      agentDraft.parse({
        agentID: id,
        name: id,
        systemPrompt: "test",
        modelID: "q",
        slotID: "auto",
        mode: "single-turn",
        skillIDs: [],
        toolIDs: [],
        enabled: true,
        timeoutMs: 30000,
        maxOutputTokens: 64,
        thinking: false,
        ...extra,
      }),
    );
  await agent("summarizer");
  await agent("worker", {
    contextMode: "persistent",
    compaction: handler ? { handler } : null,
  });
  const first = await service.submit("worker", message("a".repeat(1200)));
  await until(
    async () => (await service.run(first.runID)).state === "completed",
  );
  const original = await service.run(first.runID);
  return {
    home,
    calls,
    state,
    runtime,
    original,
    agent,
    runID: first.runID,
    get service() {
      return service;
    },
    restart: async () => {
      await service.close();
      await start();
    },
  };
}
const script = (code?: any) => ({
  type: "script" as const,
  executablePath: process.execPath,
  arguments: ["-e", code],
  timeoutMs: 1000,
});
test("script compaction preserves transcript, checkpoints, exports and persistent run identity", async (t) => {
  const f = await fixture(
    t,
    script(
      `let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const r=JSON.parse(s);if(!r.messages.length||!r.targetTokens)process.exit(2);console.log(JSON.stringify({summary:'Short summary'}));});`,
    ),
  );
  const reply = await f.service.submit("worker", message("b".repeat(600)));
  assert.equal(reply.runID, f.runID);
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  assert.equal(done.compactions.length, 1);
  assert.equal(done.compactions[0].summary, "Short summary");
  assert.deepEqual(
    done.messages.slice(0, f.original.messages.length),
    f.original.messages,
  );
  assert.equal(f.calls.at(-1).contextEpoch, 1);
  assert.ok(
    !f.calls.at(-1).messages.some((m?: any) => m.content === "a".repeat(1200)),
  );
  assert.ok(
    f.calls
      .at(-1)
      .messages.some((m?: any) => m.content.includes("Short summary")),
  );
  await f.restart();
  assert.equal((await f.service.run(f.runID)).compactions.length, 1);
  await mkdir(path.join(f.home, "exports"));
  const destination = path.join(f.home, "exports", "compaction");
  await manage(f.service, {
    command: "runs export",
    resourceID: f.runID,
    request: { destination },
  });
  assert.equal(
    JSON.parse(
      (await readFile(path.join(destination, "run.json"), "utf8")).toString(),
    ).compactions[0].summary,
    "Short summary",
  );
});
test("agent compaction releases the background slot, links a separate run, then resumes its parent", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  const child = await f.service.run(done.compactions[0].childRunID);
  assert.equal(child.parentRunID, f.runID);
  assert.equal(child.state, "completed");
  assert.equal(child.agent.contextMode, "fresh");
  assert.equal(child.compactions.length, 0);
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[0].slotID, f.calls[1].slotID);
  assert.equal(f.calls[1].slotID, f.calls[2].slotID);
  assert.ok(done.events.some((e?: any) => e.type === "compacted"));
});
test("invalid summary pauses and runs resume retries using the current handler", async (t) => {
  const f = await fixture(
    t,
    script(
      "process.stdin.resume();process.stdin.on('end',()=>console.log('{}'));",
    ),
  );
  await f.service.submit("worker", message("b".repeat(600)));
  let paused = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.equal(paused.pauseReason, "context_full");
  assert.equal(paused.compactions.length, 0);
  await f.service.patchAgent("worker", f.service.agent("worker").revision, {
    compaction: {
      maxRetries: 1,
      handler: script(
        "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({summary:'retry summary'})));",
      ),
    },
  });
  await f.service.queueControl(f.runID, "release", paused.revision, false);
  await until(async () => (await f.service.run(f.runID)).state === "completed");
  assert.equal(
    (await f.service.run(f.runID)).compactions[0].summary,
    "retry summary",
  );
});
test("oversized summary is rejected without replacing context", async (t) => {
  const f = await fixture(
    t,
    { type: "agent" as const, agentID: "summarizer" },
    "x".repeat(3000),
  );
  await f.service.submit("worker", message("b".repeat(600)));
  const paused = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.equal(paused.compactions.length, 0);
  assert.match(paused.error.message, /does not fit/);
  assert.ok(
    contextMessages(paused).some((m) => m.content === "a".repeat(1200)),
  );
});
test("missing handler pauses instead of dropping history", async (t) => {
  const f = await fixture(t, null);
  await f.service.submit("worker", message("b".repeat(600)));
  const paused = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.match(paused.error.message, /no compaction handler/);
});
test("compaction scripts have bounded time, output and cancellation", async () => {
  const request = {
    instructions: "",
    version: 1 as const,
    runID: "r",
    requestID: randomUUID(),
    previousSummary: null,
    messages: [],
    targetTokens: 10,
  };
  await assert.rejects(
    executeCompactionScript(
      { ...script("setTimeout(()=>{},10000)"), timeoutMs: 100 },
      request,
      new AbortController().signal,
    ),
    /timed out/,
  );
  await assert.rejects(
    executeCompactionScript(
      script(
        "process.stdout.write('x'.repeat(1100000));setTimeout(()=>{},10000)",
      ),
      request,
      new AbortController().signal,
    ),
    /output limit/,
  );
  await assert.rejects(
    executeCompactionScript(
      script("setTimeout(()=>{},10000)"),
      request,
      AbortSignal.timeout(50),
    ),
    /interrupted/,
  );
});

test("compactor input overflow pauses its parent without recursive compaction", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  const original = f.runtime.countTokens;
  f.runtime.countTokens = async (input) =>
    input.messages[0].content.includes("Summarize the supplied")
      ? 4000
      : original(input);
  await f.service.submit("worker", message("b".repeat(600)));
  const paused = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.match(paused.error.message, /complete compaction exchange exceeds/);
  assert.equal(f.calls.length, 1);
});
test("waiting parent and compactor survive restart without creating a second child", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  const original = f.runtime.generate;
  let entered = false;
  f.runtime.generate = async (input?: any, signal?: any) => {
    if (input.messages[0].content.includes("Summarize the supplied")) {
      entered = true;
      await new Promise<any>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("interrupted")), {
          once: true,
        });
      });
    }
    return original(input);
  };
  await f.service.submit("worker", message("b".repeat(600)));
  await until(() => entered);
  const childID = (await f.service.run(f.runID)).compaction!.childRunID!;
  f.runtime.generate = original;
  await f.restart();
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  assert.equal(done.compactions[0].childRunID, childID);
  assert.equal(
    (await f.service.listRuns()).filter((r?: any) => r.agentID === "summarizer")
      .length,
    1,
  );
});
test("compactor can switch models then restore the parent model", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  const next = structuredClone(f.service.storage.store);
  next.config.models.push({
    ...next.config.models[0],
    modelID: "other",
    compactionThresholdTokens: null,
  });
  await f.service.storage.exclusive(() => f.service.storage.saveConfig(next));
  await f.service.patchAgent("summarizer", 1, { modelID: "other" });
  await f.service.submit("worker", message("b".repeat(600)));
  await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length;
  });
  assert.deepEqual(
    f.calls.map((c) => c.modelID),
    ["q", "other", "q"],
  );
});

test("compaction accepts harmless metadata but rejects unusable summaries", async () => {
  const { summarySchema } = await import("../dist/compaction.js");
  assert.deepEqual(
    summarySchema.parse({ summary: " useful ", version: 1, extra: { a: 1 } }),
    { summary: "useful" },
  );
  for (const value of [
    { version: 1 },
    { summary: "" },
    { summary: "  " },
    { summary: 12 },
    { summary: null },
    { summary: "x".repeat(262145) },
  ])
    assert.equal(summarySchema.safeParse(value).success, false);
});

test("compaction normalizes JSON strings and fenced JSON without accepting arbitrary prose", async () => {
  const { parseCompactionSummary } = await import("../dist/compaction.js");
  assert.equal(parseCompactionSummary('"summary text"'), "summary text");
  assert.equal(
    parseCompactionSummary(
      '```json\n{"summary":"summary text","version":1}\n```',
    ),
    "summary text",
  );
  for (const value of [
    "summary prose",
    '""',
    "null",
    "[]",
    '{"version":1}',
    'prefix {"summary":"x"}',
  ])
    assert.throws(() => parseCompactionSummary(value));
});

test("compaction projects evidence without thinking or base64 and preserves originals", async () => {
  const { compactionRequest } = await import("../dist/compaction.js");
  const run: any = {
    runID: "parent",
    compactions: [],
    compaction: { requestID: "request", coveredThrough: 2, targetTokens: 100 },
    messages: [
      { role: "system" as const, content: "policy" },
      {
        messageID: "user",
        role: "user" as const,
        content: "Review this",
        attachments: [
          {
            name: "notes.txt",
            mediaType: "text/plain" as const,
            dataBase64: Buffer.from("exact evidence 123").toString("base64"),
          },
          {
            name: "audio.wav",
            mediaType: "audio/wav" as const,
            dataBase64: "AQID",
          },
        ],
        toolCalls: [],
        toolCallID: null,
      },
      {
        messageID: "answer",
        role: "assistant" as const,
        content: "Unverified plan",
        reasoningContent: "invented date",
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      },
    ],
  };
  const before = structuredClone(run);
  const request = compactionRequest(run);
  assert.match(request.messages[0].content, /exact evidence 123/);
  assert.match(request.messages[0].content, /Binary content omitted/);
  assert(!JSON.stringify(request).includes("invented date"));
  assert(!JSON.stringify(request).includes("AQID"));
  assert.deepEqual(request.messages[0].attachments, []);
  assert.deepEqual(run, before);
});

test("summary budget reserves retained context and bounds the child output reservation", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  await f.service.patchAgent(
    "summarizer",
    f.service.agent("summarizer").revision,
    { maxOutputTokens: 1536 },
  );
  const original = f.runtime.countTokens;
  f.runtime.countTokens = async (input) =>
    input.messages.some((m?: any) =>
      m.content.startsWith("Previous conversation summary"),
    )
      ? 340
      : original(input);
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  const child = await f.service.run(done.compactions[0].childRunID);
  assert.equal(JSON.parse(child.messages[1].content).targetTokens, 28);
  assert.equal(child.agent.maxOutputTokens, 156);
  assert.equal(f.service.agent("summarizer").maxOutputTokens, 1536);
});

test("thinking compactors retain their generation budget and enable reasoning", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  await f.service.patchAgent(
    "summarizer",
    f.service.agent("summarizer").revision,
    { thinking: true, maxOutputTokens: 256 },
  );
  const original = f.runtime.countTokens;
  f.runtime.countTokens = async (input) =>
    input.messages.some((m?: any) =>
      m.content.startsWith("Previous conversation summary"),
    )
      ? 340
      : input.thinking
        ? 10
        : original(input);
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  const child = await f.service.run(done.compactions[0].childRunID);
  assert.equal(child.agent.maxOutputTokens, 256);
  assert.equal(child.agent.thinking, true);
  assert.ok(
    f.calls.some(
      (input) =>
        input.thinking &&
        input.maxOutputTokens === 256 &&
        input.reasoningBudgetTokens === 128,
    ),
  );
});

test("summary evidence discrepancies warn without holding or replacing source history", async (t) => {
  const f = await fixture(
    t,
    script(
      `console.log(JSON.stringify({summary:'98% approved evidence-deadbeef'}))`,
    ),
  );
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r;
  });
  assert.equal(done.compactions.length, 1);
  assert.match(
    done.events.find((e?: any) => e.type === "compacted").data.warnings[0],
    /unsupported numeric/,
  );
  assert.equal(
    done.events.some((e?: any) => e.type === "compactionRetry"),
    false,
  );
  assert.deepEqual(
    done.messages.slice(0, f.original.messages.length),
    f.original.messages,
  );
});

test("unknown citation IDs are retained as warnings without blocking agent compaction", async (t) => {
  const f = await fixture(
    t,
    { type: "agent" as const, agentID: "summarizer" },
    "Source evidence-deadbeef",
  );
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r;
  });
  assert.match(
    done.events.find((e?: any) => e.type === "compacted").data.warnings[0],
    /unknown evidence ID/,
  );
  assert.equal(
    done.events.some((e?: any) => e.type === "compactionRetry"),
    false,
  );
});

test("compaction retains per-turn output constraints when replacing context", async (t) => {
  const f = await fixture(
    t,
    script(`console.log(JSON.stringify({summary:'Short summary'}))`),
  );
  const a = f.service.agent("worker");
  await manage(f.service, {
    command: "agents update",
    resourceID: "worker",
    request: {
      expectedRevision: a.revision,
      changes: {
        outputValidation: {
          validator: {
            type: "json-schema" as const,
            schema: {
              type: "object" as const,
              properties: { answer: { type: "string" as const } },
              required: ["answer"],
            },
          },
          repairAttempts: 0,
        },
      },
    },
  });
  f.runtime.countTokens = async (input) =>
    input.messages.some((m?: any) => m.content === "a".repeat(1200))
      ? 500
      : 100;
  const generated: any[] = [];
  f.runtime.generate = async (input) => {
    generated.push(input);
    return {
      text: '{"answer":"done"}',
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  };
  await f.service.submit("worker", message("Continue with required JSON."));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  assert.equal(done.validations.at(-1).status, "passed");
  assert.ok(
    generated[0].messages.some((m?: any) =>
      m.content.includes("Final output must be JSON matching this schema"),
    ),
  );
});

test("template failures are held as runtime errors and retain the actual cause", async (t) => {
  const f = await fixture(t, null);
  f.runtime.countTokens = async () => {
    const e = new Error(
      "Context preparation /apply-template returned HTTP 500: System message must be at the beginning.",
    );
    e.name = "ContextPreparationError";
    throw e;
  };
  await f.service.submit("worker", message("continue"));
  const held = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.pauseReason === "runtime_error" && r;
  });
  assert.equal(held.error.code, "context_preparation_failed");
  assert.match(held.error.message, /HTTP 500/);
  assert.equal(held.compaction, null);
  assert.equal(held.held, true);
  await f.restart();
  const restored = await f.service.run(f.runID);
  assert.equal(restored.pauseReason, "runtime_error");
  f.runtime.countTokens = async () => 10;
  await f.service.queueControl(f.runID, "release", restored.revision, false);
  await until(async () => (await f.service.run(f.runID)).state === "completed");
});

test("bad agent summary retries with the same target, preserves failed child and resumes", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  const generate = f.runtime.generate;
  let summaries = 0;
  const targets: any[] = [];
  f.runtime.generate = async (input) => {
    if (input.messages[0].content.includes("Summarize the supplied")) {
      targets.push(JSON.parse(input.messages[1].content).targetTokens);
      if (++summaries === 1)
        return {
          text: '{"summary":""}',
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
    }
    return generate(input);
  };
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  assert.equal(summaries, 2);
  assert.equal(targets[1], targets[0]);
  const retry = done.events.find((e?: any) => e.type === "compactionRetry");
  assert.match(retry.data.message, /valid summary/);
  const first = await f.service.run(retry.data.childRunID);
  assert.equal(first.result, '{"summary":""}');
  assert.notEqual(first.runID, done.compactions[0].childRunID);
  assert.deepEqual(
    done.messages.slice(0, f.original.messages.length),
    f.original.messages,
  );
});

test("agent compaction retries are bounded and remain exhausted across restart", async (t) => {
  const f = await fixture(
    t,
    { type: "agent" as const, agentID: "summarizer" },
    "",
  );
  await f.service.submit("worker", message("b".repeat(600)));
  const held = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.equal(held.compaction.retries, 1);
  assert.equal(held.compactions.length, 0);
  assert.equal(
    held.events.filter((e?: any) => e.type === "compactionRetry").length,
    1,
  );
  const children = (await f.service.listRuns()).filter(
    (r?: any) => r.agentID === "summarizer",
  );
  assert.equal(children.length, 2);
  await f.restart();
  await delay(100);
  assert.equal((await f.service.run(f.runID)).held, true);
  assert.equal(
    (await f.service.listRuns()).filter((r?: any) => r.agentID === "summarizer")
      .length,
    2,
  );
});

test("compactor runtime errors hold the parent without summary retry and resume together", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  const count = f.runtime.countTokens;
  let broken = true;
  f.runtime.countTokens = async (input) => {
    if (
      broken &&
      input.messages[0].content.includes("Summarize the supplied")
    ) {
      const error = Error("apply-template HTTP 500: fixture template failure");
      error.name = "ContextPreparationError";
      throw error;
    }
    return count(input);
  };
  await f.service.submit("worker", message("b".repeat(600)));
  const held = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.equal(held.pauseReason, "runtime_error");
  assert.equal(held.compaction.retries, 0);
  assert.match(held.error.message, /HTTP 500/);
  broken = false;
  await manage(f.service, {
    command: "runs resume",
    resourceID: f.runID,
    request: { expectedRevision: held.revision },
  });
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r;
  });
  assert.equal(done.compactions.length, 1);
  assert.equal(done.compactions[0].childRunID, held.compaction.childRunID);
});

test("summary evidence ignores list ordinals but still rejects invented quantities", () => {
  const request = {
    previousSummary: null,
    messages: [{ content: "Budget $50/day; confirmed" }],
  };
  assert.doesNotThrow(() =>
    validateSummaryEvidence(
      "Facts: 1) Confirmed; 6) Budget $50/day; 8) Pending; 10) Follow up\n12. Check status",
      compactionFixture(request),
    ),
  );
  for (const summary of [
    "Facts: 6) Budget $98/day",
    "Progress: 6 pages remain",
    "1. Approved 98%",
    "6) 10 messages read",
  ])
    assert.throws(
      () => validateSummaryEvidence(summary, compactionFixture(request)),
      /unsupported numeric/,
    );
});

test("summary timestamp formatting tolerates lower precision without whitelisting quantities", () => {
  const request = {
    previousSummary: null,
    messages: [{ content: "2026-11-11T05:42:35.293Z" }],
  };
  assert.doesNotThrow(() =>
    validateSummaryEvidence(
      "Window: 2026-11-11 05:42:35Z",
      compactionFixture(request),
    ),
  );
  assert.doesNotThrow(() =>
    validateSummaryEvidence(
      "2026-11-11T05:42:35.29Z",
      compactionFixture(request),
    ),
  );
  for (const summary of [
    "Count: 35",
    "2026-11-11T05:42:36Z",
    "2026-11-11T05:42:35.294Z",
  ])
    assert.throws(
      () => validateSummaryEvidence(summary, compactionFixture(request)),
      /unsupported numeric/,
    );
});

test("summary quantities accept formatting but not changed values or derived percentages", () => {
  const request = {
    previousSummary: null,
    messages: [
      {
        content:
          "1665 8004708 79221 3136 2610 12.5 9007199254740993 -1234 25% 3/4",
      },
    ],
  };
  for (const value of [
    "1,665",
    "8,004,708",
    "79,221",
    "3,136",
    "2,610",
    "12.500",
    "9,007,199,254,740,993",
    "-1,234",
    "25.0%",
    "3/4",
    "1\u202f665",
    "1\u00a0665",
  ])
    assert.doesNotThrow(
      () => validateSummaryEvidence(value, compactionFixture(request)),
      value,
    );
  for (const value of [
    "1,666",
    "90%",
    "0.25",
    "9007199254740992",
    "12.6",
    "16,65",
    "3/5",
  ])
    assert.throws(
      () => validateSummaryEvidence(value, compactionFixture(request)),
      /unsupported numeric/,
      value,
    );
  assert.doesNotThrow(() =>
    validateSummaryEvidence(
      "1665",
      compactionFixture({ previousSummary: "1,665", messages: [] }),
    ),
  );
});

test("summary decimal display rounding preserves sign and units without rounding integer IDs", () => {
  const request = {
    previousSummary: null,
    messages: [
      {
        content:
          "3136.409090909091 2610.4166666666665 -1234.567 9007199254740993 99.95%",
      },
    ],
  };
  for (const value of [
    "3,136",
    "2,610",
    "2610.42",
    "-1,234.57",
    "-1235",
    "100%",
  ])
    assert.doesNotThrow(() =>
      validateSummaryEvidence(value, compactionFixture(request)),
    );
  for (const value of ["3137", "2611", "1235", "9007199254740990", "90%"])
    assert.throws(
      () => validateSummaryEvidence(value, compactionFixture(request)),
      /unsupported numeric/,
    );
});

test("summary scanned/total notation accepts only existing component counts", () => {
  const request = {
    previousSummary: null,
    messages: [{ content: "scanned 221 out of 79221 rows" }],
  };
  assert.doesNotThrow(() =>
    validateSummaryEvidence("221/79221 rows", compactionFixture(request)),
  );
  for (const value of ["222/79221", "221/79222", "0.28%"])
    assert.throws(
      () => validateSummaryEvidence(value, compactionFixture(request)),
      /unsupported numeric/,
    );
});

test("source references restore exact generic records, not model-written claim/ID pairs", async () => {
  const { sourceEvidence, retainedSourceEvidence, evidenceContext } =
    await import("../dist/compaction.js");
  const records = [
    { id: "issue-a", owner: "A", text: "Could we ship before Friday?" },
    {
      id: "issue-b",
      owner: "B",
      text: "Not committed; estimate is still pending.",
    },
  ];
  const messages = [
    {
      messageID: "message-a",
      role: "tool" as const,
      content: JSON.stringify({ records }),
    },
  ];
  const annotated = sourceEvidence(messages);
  const refs = [...annotated.sources.keys()];
  assert.equal(refs.length, 2);
  const summary = `A committed to Friday ${refs[0]}; B approved ${refs[1]}`;
  const retained = retainedSourceEvidence(summary, messages);
  assert.deepEqual(
    retained.retained.map((r) => JSON.parse(r.content)),
    records,
  );
  assert.equal(retained.retained[0].messageID, "message-a");
  assert.equal(retained.retained[0].pointer, "/records/0");
  assert.match(
    evidenceContext(summary, messages),
    /Could we ship before Friday/,
  );
  assert.equal(messages[0].content, JSON.stringify({ records }));
  // References remain resolvable after multiple compactions without copying model prose.
  assert.deepEqual(
    retainedSourceEvidence(`Retained ${refs[0]}`, [
      ...messages,
      {
        messageID: "new",
        role: "assistant" as const,
        content: "Incorrect invented assertion",
      },
    ]).retained[0],
    retained.retained[0],
  );
});

test("source evidence is bounded, omissions explicit, and unknown references cannot inject text", async () => {
  const { sourceEvidence, retainedSourceEvidence } =
    await import("../dist/compaction.js");
  const messages = [
    {
      messageID: "m",
      role: "user" as const,
      content: "Question, not an approval.\n\nLater clarification.",
    },
  ];
  const refs = [...sourceEvidence(messages).sources.keys()];
  const missing = "src:0000000000000000";
  const all = retainedSourceEvidence([...refs, missing].join(" "), messages);
  assert.deepEqual(
    all.retained.map((r) => r.content),
    ["Question, not an approval.", "Later clarification."],
  );
  assert.deepEqual(all.omitted, [missing]);
  assert.equal(
    retainedSourceEvidence(refs.join(" "), messages, 1).retained.length,
    0,
  );
  assert.deepEqual(
    retainedSourceEvidence(refs.join(" "), messages, 1).omitted,
    refs,
  );
  assert.equal(
    sourceEvidence([
      {
        messageID: "s",
        role: "system" as const,
        content: "secret instruction",
      },
    ]).sources.size,
    0,
  );
});

test("compaction request and resumed context use the same original source references", async (t) => {
  const { compactionRequest } = await import("../dist/compaction.js");
  const f = await fixture(t, null);
  const run = structuredClone(f.original);
  run.messages[1].content = JSON.stringify({
    records: [
      { id: "a", author: "Alice", text: "Is Friday feasible?" },
      { id: "b", author: "Bob", text: "No estimate yet." },
    ],
  });
  run.compaction = {
    coveredThrough: 2,
    requestID: randomUUID(),
    targetTokens: 1024,
  } as NonNullable<typeof run.compaction>;
  const request = compactionRequest(run);
  const body = JSON.parse(request.messages[0].content);
  const ref = body.records[0].sourceRef;
  const checkpoint = {
    checkpointID: randomUUID(),
    coveredThrough: 2,
    summary: `Friday is a question ${ref}`,
  } as NonNullable<Parameters<typeof contextMessages>[1]>;
  const context = contextMessages(run, checkpoint);
  const handoff = context.find((m) =>
    m.content.includes("Original source excerpts"),
  );
  assert.ok(handoff);
  assert.match(handoff.content, /Is Friday feasible/);
  assert.match(handoff.content, /Alice/);
  assert.doesNotMatch(handoff.content, /No estimate yet/);
  assert.equal(
    JSON.parse(run.messages[1].content).records[0].text,
    "Is Friday feasible?",
  );
});

test("source reference limits apply per message so later compactions remain resolvable", async () => {
  const { sourceEvidence, retainedSourceEvidence } =
    await import("../dist/compaction.js");
  const old = {
    messageID: "old",
    role: "tool" as const,
    content: JSON.stringify(
      Array.from({ length: 2050 }, (_, i) => ({ key: i, text: "old" })),
    ),
  };
  const next = {
    messageID: "new",
    role: "tool" as const,
    content: JSON.stringify({ key: "new", text: "Later evidence" }),
  };
  const ref = [...sourceEvidence([next]).sources.keys()][0];
  assert.equal(
    retainedSourceEvidence(ref, [old, next]).retained[0].content,
    next.content,
  );
});

test("an output continuation survives compaction without losing or summarizing its saved prefix", async (t) => {
  const f = await fixture(
    t,
    script(
      `process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({summary:'prior evidence'})));`,
    ),
  );
  let workerCalls = 0;
  f.runtime.countTokens = async (input) => {
    const hasPrefix = input.messages.some(
      (m?: any) => m.content === '{"answer":',
    );
    const compacted = input.messages.some((m?: any) =>
      m.content.includes("Previous conversation summary"),
    );
    return hasPrefix && !compacted ? 500 : 100;
  };
  f.runtime.generate = async (input) => {
    workerCalls++;
    if (workerCalls === 1)
      return {
        text: '{"answer":',
        toolCalls: [],
        outputLimitReached: true,
        usage: { inputTokens: 100, outputTokens: 5 },
      };
    assert(input.messages.some((m?: any) => m.content === '{"answer":'));
    assert(
      input.messages.some((m?: any) =>
        m.content.includes("Previous conversation summary"),
      ),
    );
    return {
      text: "42}",
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 5 },
    };
  };
  await f.service.submit(f.runID, message("another task"), true);
  const r = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.segment === 1 && r;
  });
  assert.equal(r.result, '{"answer":42}');
  assert.equal(r.compactions.length, 1);
  assert.equal(workerCalls, 2);
});

test("retained source leaves preserve exact ancestor schema, units and evidence scope", async () => {
  const { sourceEvidence, retainedSourceEvidence } =
    await import("../dist/compaction.js");
  const messages = [
    {
      messageID: "source-units",
      role: "tool" as const,
      content: JSON.stringify({
        ok: true,
        result: {
          table: "meeting_recordings",
          evidenceID: "evidence-123456789abc",
          completeTable: false,
          profiles: {
            duration_ms: { min: 0, max: 8004708, unit: "milliseconds" },
          },
        },
      }),
    },
  ];
  const evidence = sourceEvidence(messages);
  const [ref] = [...evidence.sources.keys()];
  const packet = retainedSourceEvidence(
    "Unverified hypothesis. " + ref,
    messages,
  );
  assert.equal(
    (
      packet.retained[0] as (typeof packet.retained)[0] & {
        context: Record<string, unknown>;
      }
    ).context["/result/table"],
    "meeting_recordings",
  );
  assert.equal(
    (
      packet.retained[0] as (typeof packet.retained)[0] & {
        context: Record<string, unknown>;
      }
    ).context["/result/completeTable"],
    false,
  );
  assert.equal(
    (
      packet.retained[0] as (typeof packet.retained)[0] & {
        context: Record<string, unknown>;
      }
    ).context["/result/evidenceID"],
    "evidence-123456789abc",
  );
  assert.equal(JSON.parse(packet.retained[0].content).max, 8004708);
  assert.equal(JSON.parse(packet.retained[0].content).unit, "milliseconds");
});

test("oversized annotated requests compact complete prefixes without losing transcript messages", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  // Make the child exceed capacity with more than one exchange, even though
  // the unannotated parent fits the model. This models JSON/source-ref overhead.
  const originalCount = f.runtime.countTokens;
  f.runtime.countTokens = async (input) => {
    if (input.messages[0].content.includes("Summarize the supplied")) {
      const request = JSON.parse(
        input.messages.find((m?: any) => m.role === "user").content,
      );
      return request.messages.length > 2 ? 3000 : 500;
    }
    return originalCount(input);
  };
  // Add two complete old turns before a new turn triggers compaction.
  await f.service.storage.exclusive(async () => {
    const r = await f.service.run(f.runID);
    r.messages.push({
      ...message("c".repeat(800)),
      role: "user" as const,
      toolCalls: [],
      toolCallID: null,
    });
    r.messages.push({
      ...message("old answer"),
      role: "assistant" as const,
      toolCalls: [],
      toolCallID: null,
    });
    await f.service.storage.write(r);
  });
  const before = (await f.service.run(f.runID)).messages;
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length >= 2 && r;
  });
  assert.deepEqual(done.messages.slice(0, before.length), before);
  assert.ok(
    done.events.some(
      (e?: any) => e.type === "compactionRequested" && e.data.partitioned,
    ),
  );
  for (const input of f.calls.filter((i) =>
    i.messages[0].content.includes("Summarize the supplied"),
  )) {
    assert.ok(
      JSON.parse(input.messages.find((m?: any) => m.role === "user").content)
        .messages.length <= 2,
    );
  }
});

test("interactive same-model compaction runs while the owner is present", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  const { executionSlots } = await import("../dist/scheduler.js");
  const next = structuredClone(f.service.storage.store);
  next.config.slots = executionSlots(runtimeConfig(next.config));
  await f.service.storage.exclusive(() => f.service.storage.saveConfig(next));
  const slotID = next.config.slots.find((s?: any) => s.instant)!.slotID;
  await f.service.patchAgent("worker", f.service.agent("worker").revision, {
    slotID,
  });
  f.state.away = false;
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  const child = await f.service.run(done.compactions[0].childRunID);
  assert.equal(child.interactive, true);
  assert.equal(child.agent.slotID, slotID);
  assert.equal(child.state, "completed");
});

test("run detail retains measured latest-inference tokens across replies and restart", async (t) => {
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  const before = f.service.detail(await f.service.run(f.runID)).contextUsage;
  assert.equal(before!.inputTokens, 10);
  assert.equal(before!.outputTokens, 10);
  assert.equal(before!.capacityTokens, 2048);
  let measuredCompactedPrompt = false;
  const generate = f.runtime.generate;
  f.runtime.generate = async (input) => {
    if (input.messages[0].content === "test") {
      const saved = await f.service.run(f.runID);
      assert.equal(
        saved.contextUsage!.inputTokens,
        await f.runtime.countTokens(input),
      );
      assert.equal(saved.contextUsage!.outputTokens, 0);
      assert.equal(saved.compactions.length, 1);
      measuredCompactedPrompt = true;
    }
    return generate(input);
  };
  await f.service.submit("worker", message("b".repeat(600)));
  await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length;
  });
  const after = f.service.detail(await f.service.run(f.runID)).contextUsage;
  assert.equal(measuredCompactedPrompt, true);
  assert.equal(after!.segment, 1);
  assert.equal(after!.inputTokens, 10);
  assert.equal(after!.outputTokens, 10); // Latest inference, not the sum of both turns.
  await f.restart();
  assert.deepEqual(
    f.service.detail(await f.service.run(f.runID)).contextUsage,
    after,
  );
});

test("large-context compaction offers 4096 summary tokens without a word cap", async (t) => {
  const f = await fixture(
    t,
    { type: "agent" as const, agentID: "summarizer" },
    "Short summary",
    50000,
  );
  await f.service.patchAgent(
    "summarizer",
    f.service.agent("summarizer").revision,
    { maxOutputTokens: 5248, thinking: true },
  );
  f.runtime.countTokens = async (input) =>
    input.messages[0].content.includes("Summarize the supplied")
      ? 10
      : input.messages.some((m?: any) =>
            m.content.startsWith("Previous conversation summary"),
          )
        ? 100
        : 50001;
  const run = await f.service.run(f.runID);
  run.messages.push({
    ...message("next question"),
    role: "user" as const,
    toolCalls: [],
    toolCallID: null,
  });
  const ready = await f.service["prepareContext"](
    run,
    { messages: run.messages, maxOutputTokens: 2048 },
    65536,
    new AbortController().signal,
  );
  assert.equal(ready, false);
  assert.equal(run.compaction!.targetTokens, 4096);
  await f.service["reconcileCompactions"]();
  const child = await f.service.run(run.compaction!.childRunID!);
  assert.match(child.messages[0].content, /within 4096 tokens/);
  assert.doesNotMatch(child.messages[0].content, /180|words/);
  assert.equal(child.agent.thinking, true);
  assert.equal(child.agent.maxOutputTokens, 5248);
});

test("structured finish compaction preserves provenance but injects only Markdown bullets", async (t) => {
  const { structuredSummaryJSONSchema, compactionRequest } =
    await import("../dist/compaction.js");
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  await f.service.patchAgent(
    "summarizer",
    f.service.agent("summarizer").revision,
    { finishSchema: structuredSummaryJSONSchema },
  );
  const count = f.runtime.countTokens;
  f.runtime.countTokens = async (input) =>
    input.tools?.some((t: { name: string }) => t.name === "finish")
      ? 100
      : count(input);
  let expected;
  f.runtime.generate = async (input) => {
    f.calls.push(input);
    if (input.tools?.some((t: { name: string }) => t.name === "finish")) {
      const request = JSON.parse(
        input.messages.find((m?: any) => m.role === "user").content,
      );
      const ref = request.messages
        .map((m?: any) => m.content)
        .join(" ")
        .match(/src:[a-f0-9]{16}/)[0];
      expected = {
        objective: [{ text: "Continue the task.", sources: [ref] }],
        decisions: [],
        findings: [],
        nextActions: [],
      };
      return {
        text: "",
        toolCalls: [
          {
            callID: randomUUID(),
            name: "finish",
            arguments: JSON.stringify(expected),
          },
        ],
        usage: { inputTokens: 100, outputTokens: 50 },
      };
    }
    return {
      text: "done",
      toolCalls: [],
      usage: { inputTokens: 100, outputTokens: 10 },
    };
  };
  await f.service.submit("worker", message("b".repeat(600)));
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  assert.deepEqual(done.compactions[0].structuredSummary, expected);
  assert.match(
    done.compactions[0].summary,
    /## Objective\n\n- Continue the task\./,
  );
  const injected = contextMessages(done).find(
    (m) => m.messageID === done.compactions[0].checkpointID,
  )!.content;
  assert.doesNotMatch(injected, /src:[a-f0-9]{16}|a{100}|Retained original/);
  assert.deepEqual(
    done.messages.slice(0, f.original.messages.length),
    f.original.messages,
  );
  const next = compactionRequest({
    ...done,
    compaction: {
      ...done.compactions[0],
      requestID: randomUUID(),
      targetTokens: 4096,
      coveredThrough: done.messages.length - 1,
    },
  });
  assert.deepEqual(next.previousStructuredSummary, expected);
  await f.restart();
  assert.deepEqual(
    (await f.service.run(f.runID)).compactions[0].structuredSummary,
    expected,
  );
});

test("structured summaries reject wrong sections, extra fields and embedded source IDs", async () => {
  const {
    parseCompactionSummary,
    structuredSummarySchema,
    structuredSummaryJSONSchema,
  } = await import("../dist/compaction.js");
  const { z } = await import("zod");
  const valid = {
    objective: [{ text: "Keep the goal.", sources: [] }],
    decisions: [],
    findings: [],
    nextActions: [],
  };
  assert.match(
    parseCompactionSummary(JSON.stringify(valid)),
    /- Keep the goal\./,
  );
  for (const invalid of [
    { ...valid, objective: "goal" },
    { ...valid, extra: true },
    { ...valid, findings: [{ text: "src:0123456789abcdef", sources: [] }] },
  ]) {
    assert.equal(structuredSummarySchema.safeParse(invalid).success, false);
    assert.equal(
      z
        .fromJSONSchema(
          structuredSummaryJSONSchema as Parameters<typeof z.fromJSONSchema>[0],
        )
        .safeParse(invalid).success,
      false,
    );
  }
});

test("unknown structured provenance exhausts bounded retries without replacing context", async (t) => {
  const { structuredSummaryJSONSchema } = await import("../dist/compaction.js");
  const f = await fixture(t, { type: "agent" as const, agentID: "summarizer" });
  await f.service.patchAgent(
    "summarizer",
    f.service.agent("summarizer").revision,
    { finishSchema: structuredSummaryJSONSchema },
  );
  const count = f.runtime.countTokens;
  f.runtime.countTokens = async (input) =>
    input.tools?.some((t: { name: string }) => t.name === "finish")
      ? 100
      : count(input);
  f.runtime.generate = async (input) => ({
    text: "",
    toolCalls: [
      {
        callID: randomUUID(),
        name: "finish",
        arguments: JSON.stringify({
          objective: [{ text: "Goal", sources: ["src:0000000000000000"] }],
          decisions: [],
          findings: [],
          nextActions: [],
        }),
      },
    ],
    usage: { inputTokens: 100, outputTokens: 50 },
  });
  await f.service.submit("worker", message("b".repeat(600)));
  const paused = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.equal(paused.pauseReason, "context_full");
  assert.equal(paused.compactions.length, 0);
  assert.deepEqual(
    paused.messages.slice(0, f.original.messages.length),
    f.original.messages,
  );
  assert.equal(paused.compaction.retries, 1);
});
