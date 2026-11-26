import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { Service, type Runtime } from "../dist/engine/service.js";
import { callOperation } from "../dist/utils/commands/operations.js";
import { parseCLI } from "../dist/cli.js";
import { settings } from "./fixtures.ts";
const answer = {
  text: "Hello!",
  toolCalls: [],
  usage: { inputTokens: 3, outputTokens: 2 },
};
async function setup(t: import("node:test").TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-model-command-"));
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      models: ["instant", "candidate"].map((modelID) => ({
        modelID,
        kind: "chat",
        weightsPath: "/unused",
        projectorPath: null,
        idleUnloadMs: 300000,
      })),

      hooks: [],
    }),
  );
  let resident: string | undefined,
    closes = 0;
  const calls: Parameters<Runtime["generate"]>[0][] = [];
  const runtime: Runtime = {
    status: () =>
      ["instant", "candidate"].map((modelID) => ({
        modelID,
        state: resident === modelID ? "ready" : "unloaded",
      })),
    close: async () => {
      closes++;
      resident = undefined;
    },
    generate: async (input) => {
      calls.push(input);
      resident = input.modelID;
      return answer;
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
  t.after(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    home,
    service,
    runtime,
    calls,
    get closes() {
      return closes;
    },
    invoke: (
      command: string,
      resourceID?: string,
      request: object = {},
      dryRun = false,
    ) =>
      callOperation(service, {
        command,
        resourceID,
        request,
        dryRun,
      }) as Promise<any>,
  };
}
test("model testing selects arbitrary configured weights without creating runs or changing config", async (t) => {
  const f = await setup(t),
    before = await readFile(path.join(f.home, "config.json"));
  const preview = await f.invoke(
    "models test",
    "candidate",
    { prompt: "hello" },
    true,
  );
  assert.equal(preview.changed, false);
  assert.equal(f.calls.length, 0);
  const result = await f.invoke("models test", "candidate", {
    prompt: "hello",
  });
  assert.equal(result.result.text, "Hello!");
  assert.equal(result.modelID, "candidate");
  assert.ok(result.elapsedMs >= 0);
  assert.equal(f.calls[0]!.modelID, "candidate");
  assert.equal(f.calls[0]!.persistContext, false);
  assert.equal(f.calls[0]!.thinking, false);
  assert.equal(f.calls[0]!.maxOutputTokens, 64);
  assert.deepEqual(f.calls[0]!.tools, []);
  assert.equal(f.service.chats.size, 0);
  assert.deepEqual(await readdir(path.join(f.home, "runs")), []);
  assert.deepEqual(await readFile(path.join(f.home, "config.json")), before);
  const noOp = await f.invoke("models unload", "instant");
  assert.equal(noOp.changed, false);
  assert.equal(f.closes, 0);
  assert.equal(
    (await f.invoke("models unload", "candidate", {}, true)).changed,
    false,
  );
  assert.equal(f.closes, 0);
  assert.deepEqual(
    (await f.invoke("models unload", "candidate")).unloadedModelIDs,
    ["candidate"],
  );
  assert.equal(
    (await f.invoke("models unload", undefined, { all: true })).changed,
    false,
  );
  await f.invoke("models test", "candidate", {
    prompt: "again",
    thinking: true,
    maxOutputTokens: 80,
  });
  assert.deepEqual(
    (await f.invoke("models unload", undefined, { all: true }))
      .unloadedModelIDs,
    ["candidate"],
  );
  assert.notEqual(f.calls[0]!.contextID, f.calls[1]!.contextID);
  assert.equal(f.calls[1]!.thinking, true);
});
test("model commands validate targets and flag combinations without generating", async (t) => {
  const f = await setup(t);
  for (const [id, request] of [
    [undefined, {}],
    ["candidate", { all: true }],
  ] as const)
    await assert.rejects(f.invoke("models unload", id, request));
  await assert.rejects(f.invoke("models test", "missing", { prompt: "hello" }));
  await assert.rejects(f.invoke("models test", "candidate", { prompt: "" }));
  await assert.rejects(f.invoke("models unload", "missing"));
  assert.equal(f.calls.length, 0);
  assert.equal(
    parseCLI(["models", "test", "candidate", "--prompt", "hello"]).values
      .prompt,
    "hello",
  );
  assert.equal(
    parseCLI(["models", "unload", "candidate"]).resourceID,
    "candidate",
  );
  assert.equal(parseCLI(["models", "unload", "--all"]).values.all, true);
  assert.throws(() => parseCLI(["models", "unload", "a", "b"]));
  assert.throws(() => parseCLI(["models", "list", "--prompt", "hello"]));
});
test("test reservation blocks competing unloads and lets instant work run after release", async (t) => {
  const f = await setup(t);
  let release!: () => void,
    entered = false;
  f.runtime.generate = async (input) => {
    if (input.modelID === "candidate") {
      entered = true;
      await new Promise<void>((r) => {
        release = r;
      });
    }
    return answer;
  };
  const testing = f.invoke("models test", "candidate", { prompt: "hello" });
  while (!entered) await delay(5);
  await assert.rejects(f.invoke("models unload", undefined, { all: true }));
  await assert.rejects(
    f.invoke("models test", "instant", { prompt: "competing" }),
  );
  const chat = await f.service.submitChat({
    conversationID: "test",
    messages: [
      {
        messageID: randomUUID(),
        role: "user",
        content: "hello",
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      },
    ],
    skillIDs: [],
    tools: [],
    timeoutMs: 30000,
    maxOutputTokens: 64,
    temperature: 0,
  });
  await delay(25);
  assert.equal(f.service.chat(chat.requestID).state, "queued");
  release();
  await testing;
  for (
    let i = 0;
    i < 200 && f.service.chat(chat.requestID).state !== "completed";
    i++
  )
    await delay(10);
  assert.equal(f.service.chat(chat.requestID).state, "completed");
});
test("failed and timed-out tests release reservation without changing config or leaving a run", async (t) => {
  const f = await setup(t);
  f.runtime.generate = async () => {
    throw Error("invalid weights");
  };
  await assert.rejects(
    f.invoke("models test", "candidate", { prompt: "hello" }),
    /invalid weights/,
  );
  f.runtime.generate = async (_input, signal) =>
    new Promise((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(signal.reason), {
        once: true,
      }),
    );
  await assert.rejects(
    f.invoke("models test", "candidate", { prompt: "hello", timeoutMs: 1000 }),
  );
  f.runtime.generate = async () => answer;
  assert.equal(
    (await f.invoke("models test", "candidate", { prompt: "hello" })).result
      .text,
    "Hello!",
  );
  assert.deepEqual(await readdir(path.join(f.home, "runs")), []);
});

test("shutdown aborts and settles transient inference before closing the runtime", async (t) => {
  const f = await setup(t);
  let entered = false,
    stopped = false;
  f.runtime.generate = async (_input, signal) => {
    entered = true;
    return new Promise((_resolve, reject) =>
      signal.addEventListener(
        "abort",
        () => {
          stopped = true;
          reject(Error("aborted"));
        },
        { once: true },
      ),
    );
  };
  const rejected = assert.rejects(
    f.invoke("models test", "candidate", { prompt: "hello" }),
    /aborted/,
  );
  while (!entered) await delay(5);
  const close = f.runtime.close;
  f.runtime.close = async () => {
    assert.equal(stopped, true);
    await close();
  };
  await f.service.close();
  await rejected;
});

test("consolidated commands reject retired surfaces and evaluate policy only on request", async (t) => {
  const f = await setup(t);
  const { requestSchemas } = await import("../dist/utils/commands/inputs.js");
  const { configSchema } = await import("../dist/schemas/config.js");
  const { executionSlots } =
    await import("../dist/engine/scheduling/policy.js");
  for (const words of [
    ["scheduler", "explain"],
    ["runs", "search", "hello"],
  ])
    assert.throws(() => parseCLI(words));
  for (const changes of [
    { models: [] },
    { slots: [] },
    { scheduler: { contextTokens: 8192 } },
  ])
    assert.equal(
      requestSchemas["config update"].safeParse({
        expectedRevision: 1,
        changes,
      }).success,
      false,
    );
  assert.equal(
    configSchema.safeParse({ ...f.service.storage.store.config, slots: [] })
      .success,
    false,
  );
  const config = structuredClone(f.service.storage.store.config);
  config.models[0]!.contextTokens = 8192;
  config.models[1]!.contextTokens = 16384;
  config.scheduler.maxConcurrent = 3;
  const slots = executionSlots(config);
  assert.equal(slots.filter((s) => s.modelID === "instant").length, 4);
  assert.equal(slots.filter((s) => s.modelID === "candidate").length, 3);
  assert.equal(slots.filter((s) => s.instant).length, 1);
  assert.ok(
    slots.every(
      (s) => s.contextTokens === (s.modelID === "instant" ? 8192 : 16384),
    ),
  );
  const original = f.service.explainScheduler.bind(f.service);
  let evaluated = 0;
  f.service.explainScheduler = async () => {
    evaluated++;
    return original();
  };
  await f.invoke("status");
  await f.invoke("status", undefined, { details: true });
  assert.equal(evaluated, 0);
  const result = (await f.invoke("status", undefined, {
    scheduler: true,
  })) as any;
  assert.equal(evaluated, 1);
  assert.ok(result.plan && result.snapshot);
  await assert.rejects(
    f.invoke("status", undefined, { doctor: true, scheduler: true }),
  );
  assert.equal(evaluated, 1);
});

test("instant inputs reject slot selection and admit requests through the designated slot", async (t) => {
  const f = await setup(t);
  const { requestSchemas } = await import("../dist/utils/commands/inputs.js");
  const request = {
    conversationID: randomUUID(),
    messages: [
      {
        messageID: randomUUID(),
        role: "user",
        content: "hello",
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      },
    ],
    tools: [],
  };
  assert.equal(
    requestSchemas["instant create"].safeParse(request).success,
    true,
  );
  assert.equal(
    requestSchemas["instant create"].safeParse({
      ...request,
      slotID: "instant",
    }).success,
    false,
  );
  const accepted = (await f.invoke(
    "instant create",
    undefined,
    request,
  )) as any;
  for (
    let i = 0;
    i < 200 && f.service.chat(accepted.requestID).state !== "completed";
    i++
  )
    await delay(10);
  assert.equal(f.service.chat(accepted.requestID).state, "completed");
  const { executionSlots } =
    await import("../dist/engine/scheduling/policy.js");
  assert.equal(
    f.calls[0]!.slotID,
    executionSlots(f.service.storage.store.config).find((s) => s.instant)!
      .slotID,
  );
});
