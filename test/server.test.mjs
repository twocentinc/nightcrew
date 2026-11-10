import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../dist/server.js";
import { tokenHash } from "../dist/storage.js";
const token = "test-only-token";
const message = (content = "hello") => ({
  messageID: randomUUID(),
  content,
  attachments: [],
});
const chat = (m = message()) => ({
  conversationID: randomUUID(),
  modelID: "qwen",
  slotID: "instant",
  messages: [{ ...m, role: "user", toolCalls: [], toolCallID: null }],
});
async function fixture(t, generate) {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-test-"));
  const initial = {
    version: 2,
    config: {
      revision: 1,
      host: "127.0.0.1",
      port: 8888,
      interactionCooldownMs: 0,
      rootTokenHash: tokenHash(token),
      models: [
        {
          modelID: "qwen",
          kind: "chat",
          weightsPath: "/unused/test.gguf",
          projectorPath: null,
          idleUnloadMs: 1000,
        },
      ],
      slots: [
        {
          slotID: "background",
          modelID: "qwen",
          index: 0,
          contextTokens: 1024,
          instant: false,
        },
        {
          slotID: "instant",
          modelID: "qwen",
          index: 1,
          contextTokens: 1024,
          instant: true,
        },
      ],
      hooks: [],
    },
    agents: [],
    cooldownUntil: null,
  };
  await writeFile(path.join(home, "config.json"), JSON.stringify(initial), {
    mode: 0o600,
  });
  const runtime = {
    generate:
      generate ??
      (async () => ({
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      })),
    status: () => [],
    close: async () => {},
  };
  const state = { away: false };
  let app;
  const start = async () => {
    app = await startServer({
      home,
      port: 0,
      runtime,
      presence: async () => ({
        state: state.away ? "away" : "present",
        reason: "test",
        samplingHealthy: true,
        observedAt: new Date().toISOString(),
        diagnostic: null,
      }),
    });
    return app;
  };
  await start();
  t.after(async () => {
    await app.close();
    await rm(home, { recursive: true, force: true });
  });
  const request = async (method, url, body, auth = true) => {
    const response = await fetch(
      `http://127.0.0.1:${app.server.address().port}${url}`,
      {
        method,
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: `Bearer ${token}` } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    );
    return { status: response.status, body: await response.json() };
  };
  const agent = {
    agentID: "researcher",
    name: "researcher",
    systemPrompt: "Research.",
    mode: "single-turn",
    modelID: "qwen",
    slotID: "background",
    skillIDs: [],
    toolIDs: [],
    enabled: true,
  };
  assert.equal((await request("POST", "/v1/agents", { agent })).status, 200);
  return {
    home,
    state,
    request,
    get app() {
      return app;
    },
    restart: async () => {
      await app.close();
      await start();
    },
  };
}
async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw Error("Condition timed out");
}
test("HTTP authentication, schema rejection, OpenAPI, revisions and stable pagination", async (t) => {
  const f = await fixture(t);
  const q = f.request;
  assert.equal((await q("GET", "/health", undefined, false)).status, 200);
  assert.equal((await q("GET", "/v1/config", undefined, false)).status, 401);
  const config = (await q("GET", "/v1/config")).body.config;
  assert.equal(config.rootTokenHash, undefined);
  assert.equal(config.models[0].weightsPath, undefined);
  assert.equal(
    (
      await q("PATCH", "/v1/config", {
        expectedRevision: 1,
        changes: { executablePath: "/bin/x" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await q("PATCH", "/v1/config", {
        expectedRevision: 9,
        changes: { interactionCooldownMs: 1 },
      })
    ).status,
    409,
  );
  const doc = (await q("GET", "/openapi.json", undefined, false)).body;
  assert.ok(doc.paths["/v1/agents/{agentID}/runs"].post);
  assert.equal(doc.paths["/rpc"], undefined);
  assert.equal((await q("POST", "/rpc", {})).status, 404);
  const a = await q("PATCH", "/v1/agents/researcher", {
    expectedRevision: 1,
    changes: { name: "new" },
  });
  assert.equal(a.body.agent.revision, 2);
  assert.equal(
    (
      await q("PATCH", "/v1/agents/researcher", {
        expectedRevision: 1,
        changes: { name: "bad" },
      })
    ).status,
    409,
  );
});
test("durable UUID deduplication, dry runs, per-message attachments and restart discovery", async (t) => {
  const f = await fixture(t);
  const q = f.request;
  const m = message("needle");
  const preview = await q("POST", "/v1/agents/researcher/runs", {
    message: m,
    dryRun: true,
  });
  assert.equal(preview.status, 200);
  assert.equal((await readdir(path.join(f.home, "runs"))).length, 0);
  const first = await q("POST", "/v1/agents/researcher/runs", { message: m });
  assert.equal(first.status, 202);
  const replay = await q("POST", "/v1/agents/researcher/runs", { message: m });
  assert.equal(replay.status, 200);
  assert.equal(replay.body.runID, first.body.runID);
  assert.equal(
    (
      await q("POST", "/v1/agents/researcher/runs", {
        message: { ...m, content: "different" },
      })
    ).status,
    409,
  );
  const state = JSON.parse(
    await readFile(
      path.join(f.home, "runs", first.body.runID, "state.json"),
      "utf8",
    ),
  );
  assert.equal(state.messages[1].messageID, m.messageID);
  assert.equal(state.input, undefined);
  await f.restart();
  assert.equal(
    (await q("POST", "/v1/agents/researcher/runs", { message: m })).body
      .replayed,
    true,
  );
  assert.equal(
    (await q("GET", "/v1/runs/search?query=needle")).body.items.length,
    1,
  );
  assert.equal(
    (await q("POST", `/v1/runs/${first.body.runID}/cancel`, {})).body.status,
    "cancelled",
  );
  assert.equal(
    (
      await q("POST", `/v1/runs/${first.body.runID}/replies`, {
        message: message(),
      })
    ).status,
    409,
  );
});
test("interactive requests are ephemeral, retryable by UUID and never execute client tools", async (t) => {
  const f = await fixture(t);
  const input = chat();
  const first = await f.request("POST", "/v1/chat/requests", input);
  assert.equal(first.status, 202);
  assert.equal(
    (await f.request("POST", "/v1/chat/requests", input)).body.replayed,
    true,
  );
  const id = first.body.requestID;
  await until(
    async () =>
      (await f.request("GET", `/v1/chat/requests/${id}`)).body.request.state ===
      "completed",
  );
  assert.equal((await readdir(f.home)).includes("requests"), false);
  await f.restart();
  assert.equal((await f.request("GET", `/v1/chat/requests/${id}`)).status, 404);
});
test("instant work waits for compute release before starting; managed work pauses", async (t) => {
  const calls = [];
  let released = false;
  const f = await fixture(t, async (input, signal) => {
    calls.push(input.slotID);
    if (input.slotID === "background")
      await new Promise((resolve) =>
        signal.addEventListener(
          "abort",
          () => {
            setTimeout(() => {
              released = true;
              resolve();
            }, 100);
          },
          { once: true },
        ),
      );
    else assert.equal(released, true);
    return {
      text: "done",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  f.app.service.presence = {
    state: "away",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  };
  const r = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  await until(() => calls.length === 1);
  await f.request("PATCH", "/v1/config", {
    expectedRevision: 1,
    changes: { interactionCooldownMs: 300000 },
  });
  const c = await f.request("POST", "/v1/chat/requests", chat());
  await until(
    async () =>
      (await f.request("GET", `/v1/chat/requests/${c.body.requestID}`)).body
        .request.state === "completed",
  );
  assert.deepEqual(calls, ["background", "instant"]);
  assert.equal(
    (await f.request("GET", `/v1/runs/${r.body.runID}`)).body.run.state,
    "paused",
  );
});

test("completed replies preserve snapshots, attachments and stable transcript cursors", async (t) => {
  const f = await fixture(t);
  f.app.service.presence = {
    state: "away",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  };
  const q = f.request;
  const first = (
    await q("POST", "/v1/agents/researcher/runs", { message: message() })
  ).body;
  await until(
    async () =>
      (await q("GET", `/v1/runs/${first.runID}`)).body.run.state ===
      "completed",
  );
  await q("PATCH", "/v1/agents/researcher", {
    expectedRevision: 1,
    changes: { systemPrompt: "future only" },
  });
  const followup = {
    ...message("follow up"),
    attachments: [
      {
        name: "notes.txt",
        mediaType: "text/plain",
        dataBase64: Buffer.from("searchable attachment").toString("base64"),
      },
    ],
  };
  assert.equal(
    (await q("POST", `/v1/runs/${first.runID}/replies`, { message: followup }))
      .status,
    202,
  );
  const detail = (await q("GET", `/v1/runs/${first.runID}`)).body.run;
  assert.equal(detail.segment, 1);
  assert.equal(detail.agent.systemPrompt, "Research.");
  assert.equal(
    (await q("GET", "/v1/runs/search?query=searchable")).body.items.length,
    1,
  );
  const page = (await q("GET", `/v1/runs/${first.runID}/transcript?limit=1`))
    .body;
  assert.ok(page.nextCursor);
  assert.equal(
    (
      await q(
        "GET",
        `/v1/runs/${first.runID}/transcript?limit=2&cursor=${page.nextCursor}`,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await q(
        "GET",
        `/v1/runs/${first.runID}/transcript?limit=1&cursor=${page.nextCursor}`,
      )
    ).body.items.length,
    1,
  );
  await until(
    async () =>
      (await q("GET", `/v1/runs/${first.runID}`)).body.run.state ===
      "completed",
  );
  const response = await fetch(
    `http://127.0.0.1:${f.app.server.address().port}/v1/runs/${first.runID}/events`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(await response.text(), /completed/);
});

test("malformed state blocks new admission without hiding healthy history", async (t) => {
  const f = await fixture(t);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(f.home, "runs", "broken"), { mode: 0o700 });
  await writeFile(path.join(f.home, "runs", "broken", "state.json"), "{}", {
    mode: 0o600,
  });
  assert.equal(
    (
      await f.request("POST", "/v1/agents/researcher/runs", {
        message: message(),
      })
    ).status,
    503,
  );
  assert.equal((await f.request("GET", "/v1/runs")).status, 200);
});

test("managed llama router provisions from PATH and parses streamed completions", async (t) => {
  const { LlamaRuntime } = await import("../dist/runtime.js");
  const { chmod } = await import("node:fs/promises");
  const directory = await mkdtemp(
    path.join(tmpdir(), "nightcrew-process-test-"),
  );
  const binary = path.join(directory, "llama-server");
  const weights = path.join(directory, "weights.gguf");
  await writeFile(weights, "test");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst http=require('node:http');if(process.argv.includes('--help')){console.log('--models-preset --parallel --slots --kv-unified-per-slot');process.exit(0);}const port=Number(process.argv[process.argv.indexOf('--port')+1]);const server=http.createServer((req,res)=>{if(req.url==='/health'){res.end('{}');return;}if(req.url.startsWith('/slots')){res.end('[{"is_processing":false}]');return;}let body='';req.on('data',c=>body+=c);req.on('end',()=>{const input=JSON.parse(body);if(input.id_slot!==1||input.model!=='qwen'||input.chat_template_kwargs?.enable_thinking!==false||input.max_tokens!==32){res.writeHead(400);res.end();return;}res.setHeader('Content-Type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'hello'},finish_reason:null}]})+'\\n\\n');res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}})+'\\n\\n');res.end('data: [DONE]\\n\\n');});});server.listen(port,'127.0.0.1');`,
  );
  await chmod(binary, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = directory + path.delimiter + previous;
  const runtime = new LlamaRuntime(() => ({
    models: [
      {
        modelID: "qwen",
        kind: "chat",
        weightsPath: weights,
        projectorPath: null,
        idleUnloadMs: 300000,
      },
    ],
    slots: [
      {
        slotID: "background",
        modelID: "qwen",
        index: 0,
        contextTokens: 1024,
        instant: false,
      },
      {
        slotID: "instant",
        modelID: "qwen",
        index: 1,
        contextTokens: 1024,
        instant: true,
      },
    ],
  }));
  t.after(async () => {
    process.env.PATH = previous;
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  });
  await runtime.initialize();
  let text = "";
  const result = await runtime.generate(
    {
      ...chat(),
      tools: [],
      thinking: false,
      temperature: 0.7,
      maxOutputTokens: 32,
    },
    new AbortController().signal,
    (chunk) => (text += chunk),
  );
  assert.equal(result.text, "hello");
  assert.equal(text, "hello");
  assert.equal(result.usage.inputTokens, 2);
});

test("active timeout settles a run and hook delivery survives restart without replay", async (t) => {
  const f = await fixture(t, async (_input, signal) => {
    await new Promise((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    signal.throwIfAborted();
  });
  const storage = f.app.service.storage;
  const config = structuredClone(storage.store);
  config.config.hooks = [
    { event: "run.timedOut", executablePath: "/usr/bin/true", timeoutMs: 1000 },
  ];
  await storage.exclusive(() => storage.saveConfig(config));
  await f.request("PATCH", "/v1/agents/researcher", {
    expectedRevision: 1,
    changes: { timeoutMs: 1000 },
  });
  const first = (
    await f.request("POST", "/v1/agents/researcher/runs", {
      message: message(),
    })
  ).body;
  await delay(1200);
  const queued = (await f.request("GET", `/v1/runs/${first.runID}`)).body.run;
  assert.equal(queued.activeMs, 0);
  f.app.service.presence = {
    state: "away",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  };
  const settled = await until(async () => {
    const r = (await f.request("GET", `/v1/runs/${first.runID}`)).body.run;
    return r.state === "timedOut" && r.hookReceipts[0]?.status === "succeeded"
      ? r
      : false;
  });
  assert.equal(settled.activeMs, 1000);
  assert.equal(settled.hookReceipts[0].executablePath, undefined);
  await f.restart();
  assert.equal(
    (await f.request("GET", `/v1/runs/${first.runID}`)).body.run.hookReceipts
      .length,
    1,
  );
});

test("custom executable tools run with snapshotted definitions and appear in discovery", async (t) => {
  const { manage } = await import("../dist/management.js");
  let calls = 0;
  const f = await fixture(t, async (input) => {
    calls++;
    if (calls === 1) {
      assert.equal(input.tools[0].name, "inspect");
      return {
        text: "",
        toolCalls: [
          {
            callID: "inspect-1",
            name: "inspect",
            arguments: '{"query":"test"}',
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    assert.equal(JSON.parse(input.messages.at(-1).content).answer, "read-only");
    return {
      text: "finished",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const tool = {
    toolID: "inspect",
    description: "inspect fixture",
    adapter: "exec",
    executablePath: process.execPath,
    arguments: [
      "-e",
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({answer:"read-only"})));',
    ],
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,
    timeoutMs: 1000,
  };
  await manage(f.app.service, { command: "tools create", request: { tool } });
  await f.request("PATCH", "/v1/agents/researcher", {
    expectedRevision: 1,
    changes: { mode: "agent-loop", toolIDs: ["inspect"] },
  });
  assert.equal(
    (await f.request("GET", "/v1/tools/inspect")).body.tool.description,
    "inspect fixture",
  );
  const r = (
    await f.request("POST", "/v1/agents/researcher/runs", {
      message: message(),
    })
  ).body;
  const original = JSON.parse(
    await readFile(path.join(f.home, "runs", r.runID, "state.json"), "utf8"),
  );
  assert.equal(original.version, 2);
  assert.equal(original.toolSnapshots[0].toolID, "inspect");
  f.app.service.presence = {
    state: "away",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  };
  await until(
    async () =>
      (await f.request("GET", `/v1/runs/${r.runID}`)).body.run.state ===
      "completed",
  );
  assert.equal(calls, 2);
});

test("agent generation settings are snapshotted and passed to inference", async (t) => {
  let observed;
  const f = await fixture(t, async (input) => {
    observed = input;
    return {
      text: "Hello world!",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 3 },
    };
  });
  const updated = await f.request("PATCH", "/v1/agents/researcher", {
    expectedRevision: 1,
    changes: { thinking: false, maxOutputTokens: 32, temperature: 0 },
  });
  assert.equal(updated.status, 200);
  const renamed = await f.request("PATCH", "/v1/agents/researcher", {
    expectedRevision: 2,
    changes: { name: "renamed" },
  });
  assert.equal(renamed.body.agent.thinking, false);
  assert.equal(renamed.body.agent.maxOutputTokens, 32);
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message("hello world"),
  });
  await f.request("PATCH", "/v1/agents/researcher", {
    expectedRevision: 3,
    changes: { thinking: true, maxOutputTokens: 64 },
  });
  f.state.away = true;
  f.app.service.presence = {
    state: "away",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  };
  await until(() => observed);
  assert.equal(observed.thinking, false);
  assert.equal(observed.temperature, 0);
  assert.equal(observed.maxOutputTokens, 32);
  const run = (await f.request("GET", "/v1/runs/" + submitted.body.runID)).body
    .run;
  assert.equal(run.agent.thinking, false);
  assert.equal(run.agent.maxOutputTokens, 32);
});

test("turn thinking overrides persist, deduplicate and reset to agent defaults on replies", async (t) => {
  const seen = [];
  const f = await fixture(t, async (input) => {
    seen.push(input.thinking);
    return {
      text: "done",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const setAway = () => {
    f.state.away = true;
    f.app.service.presence = {
      state: "away",
      reason: "test",
      samplingHealthy: true,
      observedAt: new Date().toISOString(),
      diagnostic: null,
    };
  };
  const firstMessage = { ...message(), thinking: false };
  const first = await f.request("POST", "/v1/agents/researcher/runs", {
    message: firstMessage,
  });
  const runID = first.body.runID;
  await f.restart();
  setAway();
  const completed = () =>
    until(async () => {
      const r = (await f.request("GET", "/v1/runs/" + runID)).body.run;
      return r.state === "completed" && r;
    });
  await completed();
  assert.equal(seen[0], false);
  const replay = await f.request("POST", "/v1/agents/researcher/runs", {
    message: firstMessage,
  });
  assert.equal(replay.body.replayed, true);
  const conflict = await f.request("POST", "/v1/agents/researcher/runs", {
    message: { ...firstMessage, thinking: true },
  });
  assert.equal(conflict.status, 409);
  await f.request("POST", "/v1/runs/" + runID + "/replies", {
    message: message("default please"),
  });
  await completed();
  assert.equal(seen[1], true);
  const edited = await f.request("PATCH", "/v1/agents/researcher", {
    expectedRevision: 1,
    changes: { thinking: false },
  });
  assert.equal(edited.status, 200);
  const next = await f.request("POST", "/v1/agents/researcher/runs", {
    message: { ...message(), thinking: true },
  });
  await until(() => seen.length === 3);
  assert.equal(seen[2], true);
  await until(
    async () =>
      (await f.request("GET", "/v1/runs/" + next.body.runID)).body.run.state ===
      "completed",
  );
  assert.equal(
    (await f.request("GET", "/v1/agents/researcher")).body.agent.thinking,
    false,
  );
});

test("instant agents bypass presence and cooldown, extend cooldown, and preempt background safely", async (t) => {
  const order = [];
  let releaseBackground;
  let backgroundSignal;
  const f = await fixture(t, async (input, signal) => {
    if (input.slotID === "background") {
      order.push("background-start");
      backgroundSignal = signal;
      await new Promise((resolve) => {
        releaseBackground = resolve;
      });
      order.push("background-released");
      signal.throwIfAborted();
    }
    order.push("instant-start");
    return {
      text: "hello",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const create = await f.request("POST", "/v1/agents", {
    agent: {
      agentID: "instant-test",
      name: "instant",
      systemPrompt: "hello",
      mode: "single-turn",
      modelID: "qwen",
      slotID: "instant",
      skillIDs: [],
      toolIDs: [],
      thinking: false,
      enabled: false,
    },
  });
  assert.equal(create.status, 200);
  const state = structuredClone(f.app.service.storage.store);
  state.config.interactionCooldownMs = 60000;
  state.cooldownUntil = new Date(Date.now() + 60000).toISOString();
  await f.app.service.storage.exclusive(() =>
    f.app.service.storage.saveConfig(state),
  );
  const first = await f.request("POST", "/v1/agents/instant-test/runs", {
    message: message(),
  });
  await until(
    async () =>
      (await f.request("GET", "/v1/runs/" + first.body.runID)).body.run
        .state === "completed",
  );
  assert.deepEqual(order, ["instant-start"]);
  assert.ok(
    Date.parse(f.app.service.storage.store.cooldownUntil) > Date.now() + 50000,
  );
  order.length = 0;
  const reset = structuredClone(f.app.service.storage.store);
  reset.cooldownUntil = null;
  await f.app.service.storage.exclusive(() =>
    f.app.service.storage.saveConfig(reset),
  );
  f.state.away = true;
  f.app.service.presence = {
    state: "away",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  };
  const background = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  await until(() => backgroundSignal);
  const instant = await f.request("POST", "/v1/agents/instant-test/runs", {
    message: message(),
  });
  await until(() => backgroundSignal.aborted);
  assert.deepEqual(order, ["background-start"]);
  releaseBackground();
  await until(
    async () =>
      (await f.request("GET", "/v1/runs/" + instant.body.runID)).body.run
        .state === "completed",
  );
  assert.deepEqual(order, [
    "background-start",
    "background-released",
    "instant-start",
  ]);
  assert.equal(
    (await f.request("GET", "/v1/runs/" + background.body.runID)).body.run
      .state,
    "paused",
  );
  await delay(100);
  assert.equal(order.length, 3);
});

test("daemon logging changes live without changing unrelated configuration", async (t) => {
  const f = await fixture(t);
  const config = (await f.request("GET", "/v1/config")).body.config;
  assert.equal(config.logging.level, "warn");
  const result = await f.request("PATCH", "/v1/config", {
    expectedRevision: config.revision,
    changes: { logging: { level: "debug", maxBytes: 2048, files: 2 } },
  });
  assert.equal(result.status, 200);
  f.app.logger.emit("runtime.ready", { pid: 123 });
  await f.app.logger.flush();
  assert.match(
    await readFile(path.join(f.home, "logs/daemon.jsonl"), "utf8"),
    /runtime.ready/,
  );
  const next = await f.request("PATCH", "/v1/config", {
    expectedRevision: config.revision + 1,
    changes: { interactionCooldownMs: 10 },
  });
  assert.equal(next.body.config.logging.level, "debug");
});

test("audio adapter sends output settings and the WAV attachment to transcription", async (t) => {
  const { LlamaRuntime } = await import("../dist/runtime.js");
  const { chmod } = await import("node:fs/promises");
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-audio-"));
  const binary = path.join(home, "llama-server");
  const weights = path.join(home, "weights");
  await writeFile(weights, "fixture");
  await writeFile(
    binary,
    `#!${process.execPath}
 const http=require('node:http');if(process.argv.includes('--help')){console.log('--models-preset --parallel --slots --kv-unified-per-slot');process.exit(0);}
 http.createServer((req,res)=>{if(req.url==='/health'){res.end('{}');return;}let body='';req.on('data',c=>body+=c.toString());req.on('end',()=>{if(req.url!=='/v1/audio/transcriptions'||!body.includes('name="max_tokens"\\r\\n\\r\\n512')||!body.includes('name="temperature"\\r\\n\\r\\n0.7')||!body.includes('name="response_format"\\r\\n\\r\\njson')||!body.includes('name="prompt"\\r\\n\\r\\ntranscribe exactly')||!body.includes('audio/wav')||!body.includes('RIFF')){res.writeHead(400);res.end('{}');return;}res.end(JSON.stringify({text:'fixture transcript'}));});}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');`,
  );
  await chmod(binary, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = home + path.delimiter + previous;
  const runtime = new LlamaRuntime(
    () => ({
      models: [
        {
          modelID: "audio",
          kind: "audio",
          weightsPath: weights,
          projectorPath: null,
          idleUnloadMs: 300000,
        },
      ],
      slots: [
        {
          slotID: "audio",
          modelID: "audio",
          index: 0,
          contextTokens: 8192,
          instant: false,
        },
      ],
    }),
    home,
  );
  t.after(async () => {
    await runtime.close();
    process.env.PATH = previous;
    await rm(home, { recursive: true, force: true });
  });
  const result = await runtime.generate(
    {
      modelID: "audio",
      slotID: "audio",
      messages: [
        {
          ...message("transcribe exactly"),
          role: "user",
          toolCalls: [],
          toolCallID: null,
          attachments: [
            {
              name: "test.wav",
              mediaType: "audio/wav",
              dataBase64: Buffer.from("RIFFfixture").toString("base64"),
            },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 512,
      temperature: 0.7,
    },
    new AbortController().signal,
  );
  assert.equal(result.text, "fixture transcript");
});
