import { readStream } from "../dist/engine/models/stream.js";
import { runtimeConfig } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../dist/server/http.js";
import { tokenHash } from "../dist/storage/config.js";
const token = "test-only-token";
const message = (content = "hello") => ({
  messageID: randomUUID(),
  content,
  attachments: [],
});
const chat = (m = message()) => ({
  conversationID: randomUUID(),
  modelID: "qwen",
  messages: [{ ...m, role: "user" as const, toolCalls: [], toolCallID: null }],
});
async function fixture(t: import("node:test").TestContext, generate?: any) {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-test-"));
  const initial = {
    version: 5,
    config: {
      revision: 1,
      host: "127.0.0.1",
      port: 8888,
      interactionCooldownMs: 0,
      rootTokenHash: tokenHash(token),
      models: [
        {
          contextTokens: 1024,
          modelID: "qwen",
          kind: "chat" as const,
          weightsPath: "/unused/test.gguf",
          projectorPath: null,
          idleUnloadMs: 1000,
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
  let app: any;
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
  const request = async (method?: any, url?: any, body?: any, auth = true) => {
    const response = await fetch(
      `http://127.0.0.1:${(app.server.address() as import("node:net").AddressInfo).port}${url}`,
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
    mode: "singleTurn",
    modelID: "qwen",
    executionClass: "background",
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
async function until(fn?: any) {
  for (let i = 0; i < 200; i++) {
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
    agentVersion: 1,
    changes: { name: "new" },
  });
  assert.equal(a.body.agent.agentVersion, 2);
  assert.equal(
    (await q("GET", "/v1/agents/researcher")).body.agent.agentVersion,
    2,
  );
  assert.equal(
    (await q("PATCH", "/v1/agents/researcher", {
      expectedRevision: 2,
      changes: { name: "legacy" },
    })).status,
    400,
  );
  assert.equal(
    (
      await q("PATCH", "/v1/agents/researcher", {
        agentVersion: 1,
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
    (
      await readFile(
        path.join(f.home, "runs", first.body.runID, "state.json"),
        "utf8",
      )
    ).toString(),
  );
  assert.equal(state.messages[1].messageID, m.messageID);
  assert.equal(state.input, undefined);
  await f.restart();
  assert.equal(
    (await q("POST", "/v1/agents/researcher/runs", { message: m })).body
      .replayed,
    true,
  );
  assert.equal((await q("GET", "/v1/runs?query=needle")).body.items.length, 1);
  assert.equal(
    (await q("POST", `/v1/runs/${first.body.runID}/cancel`, {})).body.status,
    "cancelled",
  );
  const continued = await q("POST", `/v1/runs/${first.body.runID}/replies`, {
    message: message(),
  });
  assert.equal(continued.status, 202);
  assert.equal(continued.body.runID, first.body.runID);
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
  const calls: any[] = [];
  let released = false;
  const f = await fixture(t, async (input?: any, signal?: any) => {
    calls.push(input.slotID.endsWith("-1") ? "background" : "instant");
    if (input.slotID.endsWith("-1"))
      await new Promise<void>((resolve) =>
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
    (await f.request("GET", `/v1/runs/${r.body.runID}`)).body.run.execution
      .state,
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
      (await q("GET", `/v1/runs/${first.runID}`)).body.run.execution.state ===
      "completed",
  );
  await q("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { systemPrompt: "future only" },
  });
  const followup = {
    ...message("follow up"),
    attachments: [
      {
        name: "notes.txt",
        mediaType: "text/plain" as const,
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
  assert.equal(detail.turnID, followup.messageID);
  assert.equal(detail.agent.systemPrompt, "Research.");
  assert.equal(
    (await q("GET", "/v1/runs?query=searchable")).body.items.length,
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
      (await q("GET", `/v1/runs/${first.runID}`)).body.run.execution.state ===
      "completed",
  );
  const transcript = f.app.service.transcript(
    await f.app.service.run(first.runID),
  );
  const recent = await q("POST", "/v1/operations/runs/transcript", {
    resourceID: first.runID,
    request: { recent: true, limit: 2 },
  });
  assert.equal(recent.status, 200);
  assert.deepEqual(
    recent.body.items.map((e?: any) => e.sequence),
    transcript.slice(-2).map((e?: any) => e.sequence),
  );
  const after = await q("POST", "/v1/operations/runs/transcript", {
    resourceID: first.runID,
    request: { afterSequence: transcript.at(-2).sequence, limit: 2 },
  });
  assert.deepEqual(
    after.body.items.map((e?: any) => e.sequence),
    [transcript.at(-1).sequence],
  );
  assert.equal(
    (
      await q("POST", "/v1/operations/runs/transcript", {
        resourceID: first.runID,
        request: { recent: true, cursor: page.nextCursor },
      })
    ).status,
    400,
  );
  const response = await fetch(
    `http://127.0.0.1:${(f.app.server.address() as import("node:net").AddressInfo).port}/v1/runs/${first.runID}/events`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/event-stream/);
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
  const { LlamaRuntime } = await import("../dist/engine/models/runtime.js");
  const { chmod } = await import("node:fs/promises");
  const directory = await mkdtemp(
    path.join(tmpdir(), "nightcrew-process-test-"),
  );
  const binary = path.join(directory, "llama-server");
  const weights = path.join(directory, "weights.gguf");
  await writeFile(weights, "test");
  await writeFile(
    binary,
    `#!${process.execPath}\nconst http=require('node:http');if(process.argv.includes('--help')){console.log('--models-preset --parallel --slots --kv-unified-per-slot');process.exit(0);}const port=Number(process.argv[process.argv.indexOf('--port')+1]);const server=http.createServer((req,res)=>{if(req.url==='/health'){res.end('{}');return;}if(req.url.startsWith('/slots')){res.end('[{"is_processing":false}]');return;}let body='';req.on('data',c=>body+=c);req.on('end',()=>{const input=JSON.parse(body);if(input.id_slot!==0||input.model!=='qwen'||input.chat_template_kwargs?.enable_thinking!==false||input.max_tokens!==32||input.top_p!==0.95||input.top_k!==20||input.min_p!==0||input.presence_penalty!==1.5||input.repeat_penalty!==1||input.parallel_tool_calls!==false){res.writeHead(400);res.end();return;}res.setHeader('Content-Type','text/event-stream');res.write('data: '+JSON.stringify({choices:[{index:0,delta:{content:'hello'},finish_reason:null}]})+'\\n\\n');res.write('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}],usage:{prompt_tokens:2,completion_tokens:1}})+'\\n\\n');res.end('data: [DONE]\\n\\n');});});server.listen(port,'127.0.0.1');`,
  );
  await chmod(binary, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = directory + path.delimiter + previous;
  const runtime = new LlamaRuntime(() =>
    runtimeConfig({
      models: [
        {
          contextTokens: 1024,
          modelID: "qwen",
          kind: "chat" as const,
          weightsPath: weights,
          projectorPath: null,
          idleUnloadMs: 300000,
        },
      ],
    }),
  );
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
      slotID: runtime.config().slots.find((s) => s.instant)!.slotID,
      tools: [],
      thinking: false,
      parallelToolCalls: false,
      maxOutputTokens: 32,
      sampling: {
        temperature: 0.7,
        topP: 0.95,
        topK: 20,
        minP: 0,
        presencePenalty: 1.5,
        repeatPenalty: 1,
      },
    },
    new AbortController().signal,
    (chunk) => (text += chunk),
  );
  assert.equal(result.text, "hello");
  assert.equal(text, "hello");
  assert.equal(result.usage.inputTokens, 2);
});

test("active timeout settles a run and hook delivery survives restart without replay", async (t) => {
  const f = await fixture(t, async (_input?: any, signal?: any) => {
    await new Promise<any>((resolve) =>
      signal.addEventListener("abort", resolve, { once: true }),
    );
    signal.throwIfAborted();
  });
  const storage = f.app.service.storage;
  const config = structuredClone(storage.store);
  config.config.hooks = [
    {
      hookID: "test-hook",
      purpose: "notification",
      event: "run.timedOut",
      executablePath: "/usr/bin/true",
      timeoutMs: 1000,
    },
  ];
  await storage.exclusive(() => storage.saveConfig(config));
  await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
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
    return r.execution.state === "timedOut" &&
      r.hookReceipts[0]?.status === "succeeded"
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
  const { manage } = await import("../dist/utils/commands/management.js");
  let calls = 0;
  const f = await fixture(t, async (input?: any) => {
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
    executablePath: process.execPath,
    argv: [
      "-e",
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({answer:"read-only"})));',
    ],
    parameters: {
      type: "object" as const,
      properties: { query: { type: "string" as const } },
      required: ["query"],
      additionalProperties: false,
    },
    timeoutMs: 1000,
  };
  await manage(f.app.service, { command: "tools create", request: { tool } });
  await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { mode: "agentLoop", toolIDs: ["inspect"] },
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
    (
      await readFile(path.join(f.home, "runs", r.runID, "state.json"), "utf8")
    ).toString(),
  );
  assert.equal(original.version, 10);
  assert.equal(
    original.events.find((e: any) => e.type === "configurationChanged").data
      .configuration.tools[0].toolID,
    "inspect",
  );
  f.app.service.presence = {
    state: "away",
    reason: "test",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    diagnostic: null,
  };
  await until(
    async () =>
      (await f.request("GET", `/v1/runs/${r.runID}`)).body.run.execution
        .state === "completed",
  );
  assert.equal(calls, 2);
});

test("agent generation settings are snapshotted and passed to inference", async (t) => {
  let observed: any;
  const f = await fixture(t, async (input?: any) => {
    observed = input;
    return {
      text: "Hello world!",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 3 },
    };
  });
  const updated = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { thinking: false, maxOutputTokens: 32, sampling: { temperature: 0 } },
  });
  assert.equal(updated.status, 200);
  const renamed = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 2,
    changes: { name: "renamed" },
  });
  assert.equal(renamed.body.agent.thinking, false);
  assert.equal(renamed.body.agent.maxOutputTokens, 32);
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message("hello world"),
  });
  await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 3,
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
  assert.equal(observed.sampling.temperature, 0);
  assert.equal(observed.maxOutputTokens, 32);
  const run = (await f.request("GET", "/v1/runs/" + submitted.body.runID)).body
    .run;
  assert.equal(run.agent.thinking, false);
  assert.equal(run.agent.maxOutputTokens, 32);
});

test("turn thinking overrides persist, deduplicate and reset to agent defaults on replies", async (t) => {
  const seen: any[] = [];
  const f = await fixture(t, async (input?: any) => {
    seen.push(input.thinking);
    return {
      text: "done",
      reasoningContent: "Recorded reasoning",
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
      return r.execution.state === "completed" && r;
    });
  await completed();
  assert.equal(seen[0], false);
  let saved = await f.app.service.storage.read(runID);
  assert.equal(saved.messages.at(-1).thinking, false);
  assert.equal(saved.messages.at(-1).reasoningContent, undefined);
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
  saved = await f.app.service.storage.read(runID);
  assert.equal(saved.messages.at(-1).reasoningContent, "Recorded reasoning");
  assert.equal(saved.messages.at(-1).content, "done");
  await f.restart();
  setAway();
  saved = await f.app.service.storage.read(runID);
  assert.equal(saved.messages.at(-1).reasoningContent, "Recorded reasoning");
  const edited = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
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
      (await f.request("GET", "/v1/runs/" + next.body.runID)).body.run.execution
        .state === "completed",
  );
  assert.equal(
    (await f.request("GET", "/v1/agents/researcher")).body.agent.thinking,
    false,
  );
});

test("instant agents bypass presence and cooldown, extend cooldown, and preempt background safely", async (t) => {
  const order: any[] = [];
  let releaseBackground: any;
  let backgroundSignal: any;
  const f = await fixture(t, async (input?: any, signal?: any) => {
    if (input.slotID.endsWith("-1")) {
      order.push("background-start");
      backgroundSignal = signal;
      await new Promise<any>((resolve) => {
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
      mode: "singleTurn",
      modelID: "qwen",
      executionClass: "instant",
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
        .execution.state === "completed",
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
        .execution.state === "completed",
  );
  assert.deepEqual(order, [
    "background-start",
    "background-released",
    "instant-start",
  ]);
  assert.equal(
    (await f.request("GET", "/v1/runs/" + background.body.runID)).body.run
      .execution.state,
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
  const { LlamaRuntime } = await import("../dist/engine/models/runtime.js");
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
    () =>
      runtimeConfig({
        models: [
          {
            contextTokens: 8192,
            modelID: "audio",
            kind: "audio" as const,
            weightsPath: weights,
            projectorPath: null,
            idleUnloadMs: 300000,
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
      slotID: runtime.config().slots[0]!.slotID,
      messages: [
        {
          ...message("transcribe exactly"),
          role: "user" as const,
          toolCalls: [],
          toolCallID: null,
          attachments: [
            {
              name: "test.wav",
              mediaType: "audio/wav" as const,
              dataBase64: Buffer.from("RIFFfixture").toString("base64"),
            },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 512,
      sampling: { temperature: 0.7 },
    },
    new AbortController().signal,
  );
  assert.equal(result.text, "fixture transcript");
});

test("stream parser separates thinking from answers and tool calls across byte chunks", async () => {
  const { LlamaRuntime } = await import("../dist/engine/models/runtime.js");
  const runtime = new LlamaRuntime(() => runtimeConfig({ models: [] }));
  const chunks: any[] = [
    { reasoning_content: "Check " },
    { reasoning_content: "π first." },
    { content: "Answer" },
    {
      tool_calls: [
        {
          index: 0,
          id: "call",
          function: { name: "inspect", arguments: "{}" },
        },
      ],
    },
  ].map((delta) => ({ choices: [{ index: 0, delta, finish_reason: null }] }));
  chunks.push({
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
  });
  const bytes = Buffer.from(
    chunks.map((c) => "data: " + JSON.stringify(c) + "\n\n").join("") +
      "data: [DONE]\n\n",
  );
  const response = () =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
          controller.close();
        },
      }),
    );
  let streamed = "";
  const result = await readStream(
    response(),
    new AbortController().signal,
    (text: string) => (streamed += text),
    true,
  );
  assert.equal(result.reasoningContent, "Check π first.");
  assert.equal(result.text, "Answer");
  assert.equal(streamed, "Answer");
  assert.equal(result.toolCalls[0].name, "inspect");
  assert.equal(
    (
      await readStream(
        response(),
        new AbortController().signal,
        undefined,
        false,
      )
    ).reasoningContent,
    undefined,
  );
});

test("management HTTP and CLI share every oRPC operation contract", async (t) => {
  const f = await fixture(t);
  const { operationDefinitions } =
    await import("../dist/utils/commands/operations.js");
  const { getCommand } = await import("../dist/utils/commands/registry.js");
  for (const op of operationDefinitions) {
    const command = getCommand(op.name);
    assert.equal(command!.request, op.request, op.name);
    if (["agents run", "evals run", "instant create"].includes(op.name)) {
      const options = Reflect.get(command!.result, "options");
      assert.ok(Array.isArray(options));
      assert.ok(options.includes(op.result));
      assert.ok(
        options.includes(
          getCommand(op.name === "instant create" ? "instant get" : "runs get")!
            .result,
        ),
      );
    } else assert.equal(command!.result, op.result, op.name);
    const route = "/v1/operations/" + op.name.replaceAll(" ", "/");
    assert.equal(Boolean(f.app.document.paths[route]), !op.localOnly, route);
  }
  assert.deepEqual(
    Object.keys(f.app.document.paths)
      .filter((p) => p.startsWith("/v1/operations/"))
      .sort(),
    operationDefinitions
      .filter((op) => !op.localOnly)
      .map((op) => "/v1/operations/" + op.name.replaceAll(" ", "/"))
      .sort(),
    "OpenAPI must expose exactly the public shared operations",
  );
  const diagnostics = await f.request("POST", "/v1/operations/status", {
    request: { doctor: true },
  });
  assert.equal(diagnostics.status, 200);
  assert.ok(Array.isArray(diagnostics.body.checks));
  assert.equal(diagnostics.body.live, true);
  assert.equal(diagnostics.body.runtime, undefined);
  const route = "/v1/operations/agents/get";
  assert.equal(
    (
      await f.request(
        "POST",
        route,
        { resourceID: "researcher", request: {} },
        false,
      )
    ).status,
    401,
  );
  const result = await f.request("POST", route, {
    resourceID: "researcher",
    request: {},
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.item.agentID, "researcher");
  assert.equal(
    (
      await f.request("POST", route, {
        resourceID: "researcher",
        request: { unexpected: true },
      })
    ).status,
    400,
  );
});

test("failed generation retains partial answer, thinking and tool fragments as visible attempt evidence", async (t) => {
  const f = await fixture(
    t,
    async (input?: any, signal?: any, onDelta?: any, onEvidence?: any) => {
      onDelta("partial answer");
      onEvidence({
        reasoningContent: "unfinished reasoning",
        toolCalls: [
          {
            index: 0,
            callID: "call",
            name: "inspect",
            arguments: '{"incomplete":',
          },
        ],
      });
      throw Error("stream disconnected");
    },
  );
  await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: {
      mode: "agentLoop",
      thinking: true,
      toolIDs: ["runs_transcript"],
    },
  });
  f.state.away = true;
  await f.app.service["dispatch"].tick();
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  assert.equal(submitted.status, 202);
  const runID = submitted.body.runID;
  const run = await until(async () => {
    const r = await f.app.service.storage.read(runID);
    return r.state === "failed" && r;
  });
  assert.equal(run.attempts[0].text, "partial answer");
  assert.equal(run.attempts[0].reasoningContent, "unfinished reasoning");
  assert.equal(run.attempts[0].status, "failed");
  assert.equal(run.error.message, "stream disconnected");
  const visible = await f.app.service["toolStep"].invokeTool(
    run,
    "runs_transcript",
    JSON.stringify({ runID, limit: 20 }),
    new AbortController().signal,
  );
  assert.equal(
    visible.find((e?: any) => e.attempt)?.attempt.reasoningContent,
    "unfinished reasoning",
  );
  assert.equal(run.attempts[0].toolCalls[0].arguments, '{"incomplete":');
  assert.equal(
    run.messages.some((m?: any) => m.content === "partial answer"),
    false,
  );
  const transcript = f.app.service.transcript(run);
  assert.equal(
    transcript.find((e?: any) => e.attempt)?.attempt.text,
    "partial answer",
  );
  const { exportRun, verifyRun } = await import("../dist/storage/artifacts.js");
  const destination = path.join(f.home, "exports", "evidence");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.dirname(destination));
  await exportRun(f.app.service, runID, destination, false);
  assert.equal(
    (await verifyRun(f.app.service, runID, destination)).valid,
    true,
  );
});

test("storage limit holds a persistent run and delivers one bounded hook with usage", async (t) => {
  const f = await fixture(t, async () => ({
    text: "x".repeat(600000),
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const hookPath = path.join(f.home, "limit-hook");
  const output = path.join(f.home, "hook.json");
  await writeFile(hookPath, '#!/bin/sh\ncat > "' + output + '"\n', {
    mode: 0o700,
  });
  const store = structuredClone(f.app.service.storage.store);
  store.config.hooks = [
    {
      hookID: "test-hook",
      purpose: "notification",
      event: "run.storageLimit",
      executablePath: hookPath,
      timeoutMs: 1000,
    },
  ];
  await f.app.service.storage.exclusive(() =>
    f.app.service.storage.saveConfig(store),
  );
  const patched = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { contextMode: "persistent", storageLimitMB: 1 },
  });
  assert.equal(patched.status, 200);
  f.state.away = true;
  await f.app.service["dispatch"].tick();
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  const runID = submitted.body.runID;
  await until(async () => {
    const r = await f.app.service.storage.read(runID);
    return r.pauseReason === "storageLimit";
  });
  const rejected = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message("next"),
  });
  assert.equal(rejected.status, 409);
  await until(async () => {
    const r = await f.app.service.storage.read(runID);
    return r.hookReceipts.some((h?: any) => h.status === "succeeded");
  });
  const payload = JSON.parse((await readFile(output, "utf8")).toString());
  assert.equal(payload.event, "run.storageLimit");
  assert.equal(payload.storage.limit.maximum, 1024 * 1024);
  assert.ok(payload.storage.limit.used >= 1024 * 1024);
  await f.request("POST", "/v1/agents/researcher/runs", {
    message: message("again"),
  });
  const held = await f.app.service.storage.read(runID);
  assert.equal(held.held, true);
  assert.equal(
    held.events.filter((e?: any) => e.type === "storageLimit").length,
    1,
  );
  assert.equal(held.hookReceipts.length, 1);
  await f.restart();
  assert.equal(
    (await f.app.service.storage.read(runID)).pauseReason,
    "storageLimit",
  );
  const raised = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 2,
    changes: { storageLimitMB: 2 },
  });
  assert.equal(raised.status, 200);
  const beforeRelease = await f.app.service.storage.read(runID);
  await f.app.service.queueControl(
    runID,
    "release",
    beforeRelease.revision,
    false,
  );
  const released = await f.app.service.storage.read(runID);
  assert.equal(released.state, "completed");
  assert.equal(released.held, false);
  assert.equal(
    released.messages.filter((m?: any) => m.role === "assistant").length,
    1,
  );
});

test("cancelled attempts keep partial answers but omit disabled thinking", async (t) => {
  let started = false;
  const f = await fixture(
    t,
    async (input?: any, signal?: any, delta?: any, evidence?: any) => {
      delta("interrupted answer");
      evidence({
        reasoningContent: "must not retain disabled thinking",
        toolCalls: [],
      });
      started = true;
      await new Promise<any>((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      signal.throwIfAborted();
    },
  );
  const changed = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { thinking: false },
  });
  assert.equal(changed.status, 200);
  f.state.away = true;
  await f.app.service["dispatch"].tick();
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  await until(() => started);
  const runID = submitted.body.runID;
  await f.request("POST", "/v1/runs/" + runID + "/cancel", {});
  const run = await until(async () => {
    const r = await f.app.service.storage.read(runID);
    return r.attempts[0]?.status === "cancelled" && r;
  });
  assert.equal(run.attempts[0].text, "interrupted answer");
  assert.equal(run.attempts[0].reasoningContent, "");
  assert.equal(
    run.messages.some((m?: any) => m.role === "assistant"),
    false,
  );
});

test("agent loops automatically discover and load snapshotted skill files on demand", async (t) => {
  let turn = 0,
    f: any;
  f = await fixture(t, async (input?: any) => {
    assert.ok(input.tools.some((tool?: any) => tool.name === "load_skills"));
    if (turn++ === 0) {
      assert.ok(input.messages[0].content.includes("Updated review workflow"));
      assert.ok(!input.messages[0].content.includes("PRIVATE INSTRUCTIONS"));
      assert.ok(!JSON.stringify(input.messages).includes("REFERENCE CONTENT"));
      await writeFile(
        path.join(f.home, "skills", "review", "references", "guide.md"),
        "CHANGED AFTER ADMISSION",
      );
      const reloaded = await f.request("POST", "/v1/operations/config/reload", {
        request: {},
      });
      assert.equal(reloaded.status, 200);
      return {
        text: "",
        toolCalls: [
          {
            callID: "load",
            name: "load_skills",
            arguments: JSON.stringify({ skillIDs: ["review"] }),
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    const output = JSON.parse(input.messages.at(-1).content);
    if (turn === 2) {
      assert.equal(output.skills[0].instructions, "PRIVATE INSTRUCTIONS");
      assert.equal(output.skills[0].files[0].path, "references/guide.md");
      assert.ok(!JSON.stringify(output).includes("REFERENCE CONTENT"));
      return {
        text: "",
        toolCalls: [
          {
            callID: "read",
            name: "load_skills",
            arguments: JSON.stringify({
              files: [{ skillID: "review", path: "references/guide.md" }],
            }),
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    assert.equal(output.files[0].content, "REFERENCE CONTENT");
    return {
      text: "Reviewed",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const { managementClient } =
    await import("../dist/utils/commands/operations.js");
  const api = managementClient(f.app.service);
  const skill = {
    skillID: "review",
    name: "Review",
    description: "Selected review workflow",
    instructions: "PRIVATE INSTRUCTIONS",
    toolIDs: [],
    files: [
      {
        path: "references/guide.md",
        encoding: "utf8",
        content: "REFERENCE CONTENT",
      },
    ],
  };
  const created = await api["skills create"]({
    resourceID: undefined,
    request: { skill },
  });
  const fetched = await api["skills get"]({
    resourceID: "review",
    request: {},
  });
  assert.equal(created.item!.hash, fetched.item.hash);
  const listed = await api["skills list"]({ resourceID: undefined, request: {} });
  const expected = { skillID: skill.skillID, name: skill.name, description: skill.description, hash: fetched.item.hash };
  assert.deepEqual(listed.items.find((s) => s.skillID === skill.skillID), expected);
  const httpList = await f.request("GET", "/v1/skills");
  assert.equal(httpList.status, 200);
  const httpBody = httpList.body;
  assert.deepEqual(httpBody.items.find((s: any) => s.skillID === skill.skillID), expected);

  const updated = await api["skills update"]({
    resourceID: "review",
    request: {
      changes: { description: "Updated review workflow" },
    },
  });
  assert.equal(updated.item!.files.length, 1);
  assert.equal(updated.item!.instructions, skill.instructions);
  assert.deepEqual(updated.item!.toolIDs, skill.toolIDs);

  const changed = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { mode: "agentLoop", skillIDs: ["review"] },
  });
  assert.equal(changed.status, 200);
  f.state.away = true;
  await f.app.service["dispatch"].tick();
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  const run = await until(async () => {
    const r = await f.app.service.storage.read(submitted.body.runID);
    return ["completed", "invalidOutput", "failed"].includes(r.state) && r;
  });
  assert.equal(run.state, "completed", JSON.stringify(run.error));
  assert.equal(turn, 3);
  assert.ok(
    run.toolSnapshots.some(
      (t: { toolID: string }) => t.toolID === "load_skills",
    ),
  );
  assert.deepEqual(run.agent.toolIDs, []);
  assert.equal(run.skills[0].files[0].content, "REFERENCE CONTENT");
  const { verifyRun } = await import("../dist/storage/artifacts.js");
  assert.equal((await verifyRun(f.app.service, run.runID)).valid, true);
});

test("instant chats execute selected skills automatically and return client-owned calls", async (t) => {
  let step = 0;
  const f = await fixture(t, async (input?: any) => {
    assert.ok(
      input.tools.some(
        (t: import("node:test").TestContext) => t.name === "load_skills",
      ),
    );
    assert.ok(input.messages[0].content.includes("Instant selected skill"));
    assert.ok(!input.messages[0].content.includes("INSTANT INSTRUCTIONS"));
    if (step === 2) {
      step++;
      assert.deepEqual(JSON.parse(input.messages.at(-1).content), { ok: true });
      return {
        text: "Finished with client result",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    }
    if (step++ === 0)
      return {
        text: "",
        toolCalls: [
          {
            callID: "skill",
            name: "load_skills",
            arguments: JSON.stringify({ skillIDs: ["instant-skill"] }),
          },
        ],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    assert.equal(
      JSON.parse(input.messages.at(-1).content).skills[0].instructions,
      "INSTANT INSTRUCTIONS",
    );
    return {
      text: "",
      toolCalls: [
        {
          callID: "resource",
          name: "load_skills",
          arguments: JSON.stringify({
            files: [{ skillID: "instant-skill", path: "assets/template.txt" }],
          }),
        },
        { callID: "client", name: "client_action", arguments: "{}" },
      ],
      usage: { inputTokens: 2, outputTokens: 1 },
    };
  });
  const { managementClient } =
    await import("../dist/utils/commands/operations.js");
  await managementClient(f.app.service)["skills create"]({
    resourceID: undefined,
    request: {
      skill: {
        skillID: "instant-skill",
        name: "Instant",
        description: "Instant selected skill",
        instructions: "INSTANT INSTRUCTIONS",
        toolIDs: [],
        files: [
          {
            path: "assets/template.txt",
            encoding: "utf8",
            content: "TEMPLATE",
          },
        ],
      },
    },
  });
  const input = {
    ...chat(),
    skillIDs: ["instant-skill"],
    tools: [
      {
        name: "client_action",
        description: "Client owned",
        parameters: { type: "object" as const },
      },
    ],
  };
  const submitted = await f.request("POST", "/v1/chat/requests", input);
  assert.equal(submitted.status, 202);
  const c = await until(() => {
    const c = f.app.service.chat(submitted.body.requestID);
    return ["completed", "invalidOutput", "failed"].includes(c.state) && c;
  });
  assert.equal(c.state, "completed", JSON.stringify(c.error));
  assert.equal(step, 2);
  assert.deepEqual(
    c.result.toolCalls.map((t: import("node:test").TestContext) => t.name),
    ["client_action"],
  );
  assert.equal(c.result.usage.inputTokens, 3);
  const retried = await f.request("POST", "/v1/chat/requests", input);
  assert.equal(retried.body.replayed, true);

  const detail = (await f.request("GET", "/v1/chat/requests/" + c.requestID))
    .body.request;
  assert.equal(
    detail.messages.filter((m?: any) => m.role === "tool").length,
    2,
  );
  assert.equal(
    JSON.parse(detail.messages.at(-1).content).files[0].content,
    "TEMPLATE",
  );
  const followup = await f.request("POST", "/v1/chat/requests", {
    ...input,
    messages: [
      ...input.messages,
      ...detail.messages,
      {
        messageID: randomUUID(),
        role: "tool" as const,
        content: '{"ok":true}',
        attachments: [],
        toolCalls: [],
        toolCallID: "client",
      },
    ],
  });
  assert.equal(followup.status, 202);
  const finished = await until(() => {
    const c = f.app.service.chat(followup.body.requestID);
    return ["completed", "invalidOutput", "failed"].includes(c.state) && c;
  });
  assert.equal(finished.result?.text, "Finished with client result");

  assert.equal(
    (
      await f.request("POST", "/v1/chat/requests", {
        ...chat(),
        skillIDs: ["not-configured"],
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.request("POST", "/v1/chat/requests", {
        ...chat(),
        tools: [
          { name: "load_skills", description: "override", parameters: {} },
        ],
      })
    ).status,
    400,
  );
});

for (const instant of [false, true]) {
  test(`${instant ? "instant" : "background"} skill errors are paired results and the model can correct them`, async (t) => {
    let turn = 0;
    const f = await fixture(t, async (input?: any) => {
      const previous = input.messages.at(-1);
      if (turn > 0 && turn < 3) {
        assert.equal(previous.role, "tool");
        assert.equal(previous.toolCallID, `call-${turn - 1}`);
        assert.equal(JSON.parse(previous.content).ok, false);
      }
      const args = [
        '{"skillIDs":["review"],"files":[{"skillID":"review","path":"instructions"}]}',
        '{"files":[{"skillID":"review","path":"references/missing.md"}]}',
        '{"skillIDs":["review"]}',
      ];
      if (turn < args.length)
        return {
          text: "",
          toolCalls: [
            {
              callID: `call-${turn}`,
              name: "load_skills",
              arguments: args[turn++],
            },
          ],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      assert.equal(
        JSON.parse(previous.content).skills[0].instructions,
        "Recovered instructions",
      );
      turn++;
      return {
        text: "Recovered",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    const { managementClient } =
      await import("../dist/utils/commands/operations.js");
    await managementClient(f.app.service)["skills create"]({
      resourceID: undefined,
      request: {
        skill: {
          skillID: "review",
          name: "Review",
          description: "Review",
          instructions: "Recovered instructions",
          toolIDs: [],
        },
      },
    });
    let completed: any;
    if (instant) {
      const submitted = await f.request("POST", "/v1/chat/requests", {
        ...chat(),
        skillIDs: ["review"],
      });
      completed = await until(() => {
        const c = f.app.service.chat(submitted.body.requestID);
        return ["completed", "invalidOutput", "failed"].includes(c.state) && c;
      });
    } else {
      await f.request("PATCH", "/v1/agents/researcher", {
        agentVersion: 1,
        changes: { mode: "agentLoop", skillIDs: ["review"] },
      });
      f.state.away = true;
      await f.app.service["dispatch"].tick();
      const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
        message: message(),
      });
      completed = await until(async () => {
        const r = await f.app.service.storage.read(submitted.body.runID);
        return ["completed", "invalidOutput", "failed"].includes(r.state) && r;
      });
      const { verifyRun } = await import("../dist/storage/artifacts.js");
      assert.equal(
        (await verifyRun(f.app.service, completed.runID)).valid,
        true,
      );
    }
    assert.equal(completed.state, "completed", JSON.stringify(completed.error));
    assert.equal(turn, 4);
    assert.equal(
      completed.messages.filter((m?: any) => m.role === "tool").length,
      3,
    );
  });
}

test("history tools exclude the current nonterminal run", async (t) => {
  const f = await fixture(t);
  await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { mode: "agentLoop", toolIDs: ["runs_list", "runs_transcript"] },
  });
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  const run = await f.app.service.storage.read(submitted.body.runID);
  const signal = new AbortController().signal;
  const list = await f.app.service["toolStep"].invokeTool(
    run,
    "runs_list",
    "{}",
    signal,
  );
  assert.deepEqual(list, []);
  const history = await f.app.service["toolStep"].invokeTool(
    run,
    "runs_transcript",
    JSON.stringify({ runID: run.runID }),
    signal,
  );
  assert.equal(history.ok, false);
  assert.equal(history.error.code, "current_run_history");
});

test("worker history bounds long evidence while administrator transcripts remain complete", async (t) => {
  const long = "evidence ".repeat(3000);
  const f = await fixture(t, async () => ({
    text: long,
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { mode: "agentLoop", toolIDs: ["runs_transcript"] },
  });
  f.state.away = true;
  await f.app.service["dispatch"].tick();
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  const run = await until(async () => {
    const r = await f.app.service.storage.read(submitted.body.runID);
    return r.state === "completed" && r;
  });
  const output = await f.app.service["toolStep"].invokeTool(
    run,
    "runs_transcript",
    JSON.stringify({ runID: run.runID, limit: 100 }),
    new AbortController().signal,
  );
  assert(JSON.stringify(output).length < 12500);
  assert(JSON.stringify(output).includes("truncated"));
  assert.equal(run.result, long);
  assert(
    f.app.service
      .transcript(run)
      .some((e?: any) => e.message?.content === long),
  );
  // One large entry must advance the cursor instead of returning the same
  // unpageable entry forever. The full administrator evidence stays intact.
  run.messages.at(-1).toolCalls = Array.from({ length: 10 }, (_, index) => ({
    callID: `large-${index}`,
    name: "runs_transcript",
    arguments: JSON.stringify({ evidence: long }),
  }));
  await f.app.service.storage.write(run);
  const offset = f.app.service
    .transcript(run)
    .findIndex(
      (e?: any) => e.message?.messageID === run.messages.at(-1).messageID,
    );
  assert(offset >= 0);
  const oversized = await f.app.service["toolStep"].invokeTool(
    run,
    "runs_transcript",
    JSON.stringify({ runID: run.runID, offset, limit: 100 }),
    new AbortController().signal,
  );
  assert.equal(oversized[0].truncated, true);
  assert.equal(oversized[0].nextOffset, offset + 1);
  assert(JSON.stringify(oversized).length < 12500);
});

test("agent sampling settings are validated, snapshotted and forwarded to inference", async (t) => {
  let sampled;
  const f = await fixture(t, async (input?: any) => {
    sampled = input.sampling;
    return {
      text: "done",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const sampling = {
    temperature: 0.7,
    topP: 0.95,
    topK: 20,
    minP: 0,
    presencePenalty: 1.5,
    repeatPenalty: 1,
  };
  const changed = await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { sampling, parallelToolCalls: false },
  });
  assert.equal(changed.status, 200);
  f.state.away = true;
  await f.app.service["dispatch"].tick();
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  const run = await until(async () => {
    const r = await f.app.service.storage.read(submitted.body.runID);
    return r.state === "completed" && r;
  });
  assert.deepEqual(sampled, sampling);
  assert.deepEqual(run.agent.sampling, sampling);
  const { agentSchema } = await import("../dist/schemas/agent.js");
  assert.equal(agentSchema.safeParse(run.agent).success, true);
  assert.equal(
    agentSchema.safeParse({ ...run.agent, sampling: { presencePenalty: 3 } })
      .success,
    false,
  );
});

test("tool budget rejects excess batch calls and requests a tool-free final answer", async (t) => {
  let turns = 0;
  const f = await fixture(t, async (input?: any) => {
    if (++turns === 1)
      return {
        text: "",
        toolCalls: [0, 1].map((i) => ({
          callID: `budget-${i}`,
          name: "runs_list",
          arguments: "{}",
        })),
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    assert.deepEqual(input.tools, []);
    assert.match(input.messages.at(-1).content, /budget.*exhausted/);
    return {
      text: "Supported result; research was bounded.",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  await f.request("PATCH", "/v1/agents/researcher", {
    agentVersion: 1,
    changes: { mode: "agentLoop", toolIDs: ["runs_list"], maxToolCalls: 1 },
  });
  let invoked = 0;
  const invoke = f.app.service["toolStep"].invokeTool.bind(
    f.app.service["toolStep"],
  );
  f.app.service["toolStep"].invokeTool = (...args: any[]) => {
    invoked++;
    return invoke(...args);
  };
  f.state.away = true;
  await f.app.service["dispatch"].tick();
  const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
    message: message(),
  });
  const run = await until(async () => {
    const r = await f.app.service.storage.read(submitted.body.runID);
    return r.state === "completed" && r;
  });
  assert.equal(invoked, 1);
  assert.equal(turns, 2);
  const results = run.messages.filter((m?: any) => m.role === "tool");
  assert.equal(results.length, 2);
  assert.equal(
    JSON.parse(results[1].content).error.code,
    "tool_budget_exhausted",
  );
  assert.equal(JSON.parse(results[1].content).error.outcome, "not_started");
});

for (const emptyAgain of [false, true])
  test(`empty agent answers get one tool-free retry (${emptyAgain ? "failure" : "recovery"})`, async (t) => {
    let turns = 0;
    const f = await fixture(t, async (input?: any) => {
      turns++;
      if (turns === 1)
        return {
          text: "",
          reasoningContent: "Unverified private draft",
          toolCalls: [],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      assert.equal(input.thinking, false);
      assert.deepEqual(input.tools, []);
      assert.match(input.messages.at(-1).content, /no visible answer/);
      return {
        text: emptyAgain ? "" : "Verified visible answer",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      };
    });
    await f.request("PATCH", "/v1/agents/researcher", {
      agentVersion: 1,
      changes: { mode: "agentLoop" },
    });
    f.state.away = true;
    await f.app.service["dispatch"].tick();
    const submitted = await f.request("POST", "/v1/agents/researcher/runs", {
      message: message(),
    });
    const run = await until(async () => {
      const r = await f.app.service.storage.read(submitted.body.runID);
      return ["completed", "invalidOutput", "failed"].includes(r.state) && r;
    });
    assert.equal(turns, 2);
    assert.equal(run.state, emptyAgain ? "failed" : "completed");
    assert.equal(run.result, emptyAgain ? null : "Verified visible answer");
    assert(
      run.messages.some(
        (m?: any) => m.reasoningContent === "Unverified private draft",
      ),
    );
  });

test("fleet overview HTTP uses the same authenticated outcome contract as the CLI", async (t) => {
  const f = await fixture(t);
  const route = "/v1/operations/status";
  assert.equal(
    (await f.request("POST", route, { request: {} }, false)).status,
    401,
  );
  const result = await f.request("POST", route, { request: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.agents[0].agentID, "researcher");
  assert.equal(result.body.agents[0].latestRun, null);
  assert.deepEqual(result.body.issues, []);
  const schema = await f.request("GET", "/openapi.json");
  assert.ok(schema.body.paths[route]);
});

test("length finish reasons are recoverable only for managed continuations; broken streams still fail", async () => {
  const { LlamaRuntime } = await import("../dist/engine/models/runtime.js");
  const runtime = new LlamaRuntime(() => runtimeConfig({}));
  const response = (done = true, finish = "length") =>
    new Response(
      "data: " +
        JSON.stringify({
          choices: [
            {
              index: 0,
              delta: {
                content: "prefix",
                tool_calls: [
                  { index: 0, function: { name: "inspect", arguments: "{" } },
                ],
              },
              finish_reason: finish,
            },
          ],
        }) +
        "\n\n" +
        (done ? "data: [DONE]\n\n" : ""),
    );
  let fragments;
  const r = await readStream(
    response(),
    new AbortController().signal,
    undefined,
    true,
    (v?: any) => (fragments = v),
    true,
  );
  assert.equal(r.outputLimitReached, true);
  assert.equal(r.text, "prefix");
  assert.deepEqual(r.toolCalls, []);
  assert.equal(fragments!.toolCalls[0].arguments, "{");
  await assert.rejects(
    readStream(response(), new AbortController().signal),
    /Incomplete generation/,
  );
  await assert.rejects(
    readStream(
      response(false),
      new AbortController().signal,
      undefined,
      true,
      undefined,
      true,
    ),
    /Incomplete generation/,
  );
  await assert.rejects(
    readStream(
      response(true, "content_filter"),
      new AbortController().signal,
      undefined,
      true,
      undefined,
      true,
    ),
    /Incomplete generation/,
  );
});

test("instant completion is published only after its cooldown is durable", async (t) => {
  let release: any;
  const f = await fixture(t, async () => {
    await new Promise<any>((resolve) => (release = resolve));
    return {
      text: "hello",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  });
  const next = structuredClone(f.app.service.storage.store);
  next.config.interactionCooldownMs = 5000;
  await f.app.service.storage.exclusive(() =>
    f.app.service.storage.saveConfig(next),
  );
  const accepted = await f.request("POST", "/v1/chat/requests", chat());
  assert.equal(accepted.status, 202);
  await until(() => release);
  const original = f.app.service.storage.saveConfig.bind(f.app.service.storage);
  let persist: any;
  f.app.service.storage.saveConfig = async (value?: any) => {
    await new Promise<any>((resolve) => (persist = resolve));
    return original(value);
  };
  release();
  await until(() => persist);
  assert.equal(f.app.service.chat(accepted.body.requestID).state, "running");
  persist();
  await until(
    () => f.app.service.chat(accepted.body.requestID).state === "completed",
  );
  assert.ok(Date.parse(f.app.service.storage.store.cooldownUntil) > Date.now());
});

test("runtime reports loading and unloading until their operations settle", async () => {
  const { LlamaRuntime } = await import("../dist/engine/models/runtime.js");
  const runtime = new LlamaRuntime(() =>
    runtimeConfig({ models: [{ modelID: "q", kind: "chat" }] }),
  );
  let releaseLoad: any;
  runtime["server"]["start"] = () =>
    new Promise<any>((resolve) => {
      releaseLoad = resolve;
    });
  const preparing = runtime["prepare"]("q", new AbortController().signal);
  assert.equal(runtime.status()[0].state, "loading");
  releaseLoad();
  await preparing;
  assert.equal(runtime.status()[0].state, "ready");
  let releaseStop: any;
  runtime["server"]["stop"] = () =>
    new Promise<void>((resolve) => {
      releaseStop = () => {
        runtime["loadedModel"] = undefined;
        resolve();
      };
    });
  const closing = runtime.close();
  assert.equal(runtime.status()[0].state, "unloading");
  releaseStop();
  await closing;
  assert.equal(runtime.status()[0].state, "unloaded");
});

test("SSE library handles comments, multiline data, CR framing and ignores post-DONE events", async () => {
  const text =
    ': keepalive\revent: message\rdata: {"choices":\rdata: [{"index":0,"delta":{"content":"π"},"finish_reason":"stop"}]}\r\rdata: [DONE]\r\rdata: invalid after done\r\r';
  const bytes = Buffer.from(text);
  const response = new Response(
    new ReadableStream({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
  );
  const result = await readStream(response, new AbortController().signal);
  assert.equal(result.text, "π");
  assert.deepEqual(result.toolCalls, []);
  await assert.rejects(
    readStream(new Response("data: [DONE]"), new AbortController().signal),
    /Incomplete generation/,
  );
});

test("instant HTTP delete discards a result and removed operations stay absent", async (t) => {
  const f = await fixture(t);
  const created = await f.request("POST", "/v1/operations/instant/create", {
    request: chat(),
  });
  assert.equal(created.status, 200);
  const id = created.body.requestID;
  const deleted = await f.request("DELETE", `/v1/chat/requests/${id}`);
  assert.equal(deleted.status, 200);
  assert.equal(deleted.body.status, "deleted");
  assert.equal((await f.request("GET", `/v1/chat/requests/${id}`)).status, 404);
  const schema = (await f.request("GET", "/openapi.json")).body;
  for (const route of [
    "/v1/operations/runs/review",
    "/v1/operations/runs/annotate",
    "/v1/operations/runs/hooks/retry",
    "/v1/operations/instant/submit",
    "/v1/chat/requests/{requestID}/cancel",
  ])
    assert.equal(schema.paths[route], undefined);
});

test("HTTP eval definitions create ordinary runs and expose completed grading", async (t) => {
  const f = await fixture(t);
  const route = "/v1/operations/evals/";
  const definition = {
    evalID: "http-eval",
    agentID: "researcher",
    messages: [{ role: "user", content: "hello" }],
    grader: { schema: { type: "string", const: "done" } },
  };
  assert.equal(
    (
      await f.request(
        "POST",
        route + "create",
        { request: { eval: definition } },
        false,
      )
    ).status,
    401,
  );
  const created = await f.request("POST", route + "create", {
    request: { eval: definition },
  });
  assert.equal(created.status, 200);
  assert.ok(created.body.item.definition.messages[0].messageID);
  const submit = await f.request("POST", route + "run", {
    resourceID: "http-eval",
    request: {},
  });
  assert.equal(submit.status, 200);
  f.state.away = true;
  let completed: any;
  for (let i = 0; i < 500; i++) {
    const result = await f.request("POST", "/v1/operations/runs/get", {
      resourceID: submit.body.runID,
      request: {},
    });
    if (result.body.run.evaluation.grade.status === "passed") {
      completed = result.body.run;
      break;
    }
    await delay(10);
  }
  assert.equal(completed?.execution.state, "completed");
  assert.equal(completed?.evaluation.definition.evalID, "http-eval");
  assert.equal(
    (
      await f.request("POST", route + "delete", {
        resourceID: "http-eval",
        request: {},
        yes: true,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("POST", "/v1/operations/runs/get", {
        resourceID: submit.body.runID,
        request: {},
      })
    ).status,
    200,
  );
});

test("capability patches preserve omitted fields and lists expose only summaries", async (t) => {
  const f = await fixture(t);
  const {managementClient} = await import("../dist/utils/commands/operations.js");
  const api = managementClient(f.app.service);
  const tool = {toolID:"patchable",description:"before",executablePath:process.execPath,argv:["--version"],timeoutMs:3210,parameters:{type:"object"}};
  const created = await api["tools create"]({resourceID:undefined,request:{tool}});
  const patch = {resourceID:tool.toolID,request:{changes:{description:"after"}}};
  const updated = await api["tools update"](patch);
  assert.deepEqual(updated.item, {...tool,description:"after",hash:updated.item!.hash});
  assert.deepEqual((await api["tools update"](patch)).item, updated.item);
  const legacyPatch = {
    ...patch,
    request: { ...patch.request, expectedHash: created.item!.hash },
  };
  await assert.rejects(api["tools update"](legacyPatch));
  const listed = await api["tools list"]({resourceID:undefined,request:{}});
  const expected = {toolID:tool.toolID,description:"after",hash:updated.item!.hash,builtin:false};
  assert.deepEqual(listed.items.find(x=>x.toolID===tool.toolID),expected);
  const httpTools = await f.request("GET","/v1/tools");
  assert.deepEqual(httpTools.body.items.find((x:any)=>x.toolID===tool.toolID),expected);
  assert.equal((await f.request("GET","/v1/tools/patchable")).body.tool.executablePath, process.execPath);
  const agents = await api["agents list"]({resourceID:undefined,request:{}});
  assert.equal("systemPrompt" in agents.items[0]!,false);
  assert.equal("finishSchema" in agents.items[0]!,false);
  const httpAgents = await f.request("GET","/v1/agents");
  assert.deepEqual(httpAgents.body.items,agents.items);
  assert.equal((await f.request("GET","/v1/agents/researcher")).body.agent.systemPrompt,"Research.");
});
