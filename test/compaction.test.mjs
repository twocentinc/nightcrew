import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Storage, initializeHome } from "../dist/storage.js";
import { Service } from "../dist/service.js";
import { manage } from "../dist/management.js";
import {
  executeCompactionScript,
  contextMessages,
} from "../dist/compaction.js";
const message = (content) => ({
  messageID: randomUUID(),
  content,
  attachments: [],
});
async function until(fn) {
  for (let i = 0; i < 400; i++) {
    const v = await fn();
    if (v) return v;
    await delay(10);
  }
  throw Error("Timeout");
}
async function fixture(t, handler, summary = "Short summary") {
  const home = await mkdtemp(path.join(tmpdir(), "nc-compact-"));
  await initializeHome(home, {
    host: "127.0.0.1",
    port: 6970,
    interactionCooldownMs: 0,
    scheduler: { contextTokens: 1024 },
    models: [
      {
        modelID: "q",
        kind: "chat",
        weightsPath: "/unused",
        projectorPath: null,
        idleUnloadMs: 300000,
        compactionThresholdTokens: 400,
      },
    ],
    slots: [],
    hooks: [],
  });
  const calls = [];
  let service;
  const state = { away: true };
  const runtime = {
    status: () => [],
    close: async () => {},
    countTokens: async (input) =>
      Math.ceil(
        JSON.stringify(input.messages.map((m) => m.content)).length / 4,
      ) + 10,
    generate: async (input) => {
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
  const agent = async (id, extra = {}) =>
    service.createAgent({
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
      ...extra,
    });
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
const script = (code) => ({
  type: "script",
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
    !f.calls.at(-1).messages.some((m) => m.content === "a".repeat(1200)),
  );
  assert.ok(
    f.calls.at(-1).messages.some((m) => m.content.includes("Short summary")),
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
    JSON.parse(await readFile(path.join(destination, "run.json"), "utf8"))
      .compactions[0].summary,
    "Short summary",
  );
});
test("agent compaction releases the background slot, links a separate run, then resumes its parent", async (t) => {
  const f = await fixture(t, { type: "agent", agentID: "summarizer" });
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
  assert.ok(done.events.some((e) => e.type === "compacted"));
});
test("invalid summary pauses and queue release retries using the current handler", async (t) => {
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
    { type: "agent", agentID: "summarizer" },
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
    version: 1,
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
  const f = await fixture(t, { type: "agent", agentID: "summarizer" });
  const original = f.runtime.countTokens;
  f.runtime.countTokens = async (input) =>
    input.messages[0].content.includes("Summarize the supplied")
      ? 2000
      : original(input);
  await f.service.submit("worker", message("b".repeat(600)));
  const paused = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.held && r;
  });
  assert.match(paused.error.message, /recursive compaction is disabled/);
  assert.equal(f.calls.length, 1);
});
test("waiting parent and compactor survive restart without creating a second child", async (t) => {
  const f = await fixture(t, { type: "agent", agentID: "summarizer" });
  const original = f.runtime.generate;
  let entered = false;
  f.runtime.generate = async (input, signal) => {
    if (input.messages[0].content.includes("Summarize the supplied")) {
      entered = true;
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(Error("interrupted")), {
          once: true,
        });
      });
    }
    return original(input);
  };
  await f.service.submit("worker", message("b".repeat(600)));
  await until(() => entered);
  const childID = (await f.service.run(f.runID)).compaction.childRunID;
  f.runtime.generate = original;
  await f.restart();
  const done = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.state === "completed" && r.compactions.length && r;
  });
  assert.equal(done.compactions[0].childRunID, childID);
  assert.equal(
    (await f.service.listRuns()).filter((r) => r.agentID === "summarizer")
      .length,
    1,
  );
});
test("compactor can switch models then restore the parent model", async (t) => {
  const f = await fixture(t, { type: "agent", agentID: "summarizer" });
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
  const run = {
    runID: "parent",
    compactions: [],
    compaction: { requestID: "request", coveredThrough: 2, targetTokens: 100 },
    messages: [
      { role: "system", content: "policy" },
      {
        messageID: "user",
        role: "user",
        content: "Review this",
        attachments: [
          {
            name: "notes.txt",
            mediaType: "text/plain",
            dataBase64: Buffer.from("exact evidence 123").toString("base64"),
          },
          { name: "audio.wav", mediaType: "audio/wav", dataBase64: "AQID" },
        ],
        toolCalls: [],
        toolCallID: null,
      },
      {
        messageID: "answer",
        role: "assistant",
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
  const f = await fixture(t, { type: "agent", agentID: "summarizer" });
  await f.service.patchAgent(
    "summarizer",
    f.service.agent("summarizer").revision,
    { maxOutputTokens: 1536 },
  );
  const original = f.runtime.countTokens;
  f.runtime.countTokens = async (input) =>
    input.messages.some((m) =>
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

test("unsupported summary quantities hold the parent without replacing source context", async (t) => {
  const f = await fixture(
    t,
    script(`console.log(JSON.stringify({summary:'98% approved (215/217)'}))`),
  );
  await f.service.submit("worker", message("b".repeat(600)));
  const held = await until(async () => {
    const r = await f.service.run(f.runID);
    return r.pauseReason === "context_full" && r;
  });
  assert.equal(held.compactions.length, 0);
  assert.match(held.error.message, /unsupported numeric/);
  assert.deepEqual(
    held.messages.slice(0, f.original.messages.length),
    f.original.messages,
  );
  assert.equal(f.service.detail(held).outcome.needsReview, true);
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
            type: "json-schema",
            schema: {
              type: "object",
              properties: { answer: { type: "string" } },
              required: ["answer"],
            },
          },
          repairAttempts: 0,
        },
      },
    },
  });
  f.runtime.countTokens = async (input) =>
    input.messages.some((m) => m.content === "a".repeat(1200)) ? 500 : 100;
  const generated = [];
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
    generated[0].messages.some((m) =>
      m.content.includes("Final output must be JSON matching this schema"),
    ),
  );
});
