import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Service, type Runtime } from "../dist/engine/service.js";
import type { Runner } from "../dist/engine/execution/runner.js";
import { LlamaRuntime } from "../dist/engine/models/runtime.js";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { callOperation } from "../dist/utils/commands/operations.js";
import { agentDraft, runtimeConfig, settings } from "./fixtures.ts";

const answer = {
  text: "done",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
};
const message = (content: string) => ({
  messageID: randomUUID(),
  content,
  attachments: [],
});
function gate() {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => (open = resolve));
  return { promise, open };
}
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < deadline, "Condition timed out");
    await delay(5);
  }
}
async function aborted(signal: AbortSignal) {
  if (signal.aborted) return;
  await new Promise<void>((resolve) =>
    signal.addEventListener("abort", () => resolve(), { once: true }),
  );
}
type Input = Parameters<Runtime["generate"]>[0];
type StopOptions = { saveSnapshots?: boolean };

async function setup(t: TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-presence-release-"));
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      models: [
        {
          modelID: "q",
          kind: "chat",
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 600000,
        },
      ],
      hooks: [],
    }),
  );
  const storage = new Storage(home);
  const runtime = new LlamaRuntime(() => storage.store.config, home);
  const stops: StopOptions[] = [];
  const calls: Array<{ input: Input; signal: AbortSignal }> = [];
  const gates: ReturnType<typeof gate>[] = [];
  const behavior = {
    generate: async (_input: Input, _signal: AbortSignal) => answer,
    stop: async () => {},
  };
  runtime.initialize = async () => {};
  runtime.countTokens = async () => 1;
  runtime.generate = async (input, signal) => {
    assert.equal(
      runtime.isBusy(),
      false,
      "Inference cannot race model unloading",
    );
    assert.equal(runtime.used.has(input.slotID), false);
    clearTimeout(runtime.idleTimer);
    runtime.used.set(input.slotID, input.modelID);
    runtime.loadedModel = input.modelID;
    calls.push({ input, signal });
    try {
      return await behavior.generate(input, signal);
    } finally {
      runtime.used.delete(input.slotID);
      if (!runtime.used.size) runtime.scheduleIdle(input.modelID);
    }
  };
  let stopping = false;
  runtime.server.stop = async (options?: StopOptions) => {
    assert.equal(
      runtime.used.size,
      0,
      "Model must outlive every occupied slot",
    );
    assert.equal(
      stopping,
      false,
      "Concurrent unloads must share one operation",
    );
    stopping = true;
    stops.push(options ?? {});
    clearTimeout(runtime.idleTimer);
    try {
      await behavior.stop();
      runtime.loadedModel = undefined;
    } finally {
      stopping = false;
    }
  };
  const state = { away: true, healthy: true, sampleFails: false };
  const sample = () => ({
    state: state.away ? ("away" as const) : ("present" as const),
    samplingHealthy: state.healthy,
    observedAt: new Date().toISOString(),
    reason: "test",
    diagnostic: null,
  });
  const service = new Service(storage, runtime, async () => {
    if (state.sampleFails) throw Error("Presence unavailable");
    return sample();
  });
  await service.initialize();
  let closing: Promise<void> | undefined;
  const close = () => (closing ??= service.close());
  t.after(async () => {
    for (const item of gates) item.open();
    await close();
    await rm(home, { recursive: true, force: true });
  });
  return {
    service,
    storage,
    runtime,
    stops,
    calls,
    behavior,
    state,
    close,
    gate() {
      const item = gate();
      gates.push(item);
      return item;
    },
    async presence(away: boolean, healthy = true) {
      state.away = away;
      state.healthy = healthy;
      service.presence = sample();
      await service["dispatch"].tick();
    },
    async agent(executionClass: "background" | "instant" = "background") {
      const agentID = executionClass;
      await service.createAgent(
        agentDraft.parse({
          agentID,
          name: agentID,
          systemPrompt: "test",
          modelID: "q",
          executionClass,
          mode: "singleTurn",
          skillIDs: [],
          toolIDs: [],
          enabled: true,
          timeoutMs: 30000,
          maxOutputTokens: 64,
        }),
      );
      return agentID;
    },
    chat() {
      return service.submitChat({
        conversationID: "presence-test",
        messages: [
          {
            ...message("requested chat"),
            role: "user",
            toolCalls: [],
            toolCallID: null,
          },
        ],
        skillIDs: [],
        tools: [],
        timeoutMs: 30000,
        maxOutputTokens: 64,
        sampling: { temperature: 0 },
      });
    },
  };
}

test("presence pauses a durable run, releases only after inference drains, and resumes its transcript", async (t) => {
  const f = await setup(t);
  const drain = f.gate();
  const seenAbort = f.gate();
  let attempts = 0;
  f.behavior.generate = async (_input, signal) => {
    if (++attempts === 1) {
      await aborted(signal);
      seenAbort.open();
      await drain.promise;
      signal.throwIfAborted();
    }
    return answer;
  };
  const original = message("keep this request when I return");
  const { runID } = await f.service.submit(await f.agent(), original);
  await until(async () => {
    const run = await f.service.run(runID);
    assert.equal(run.error, null, JSON.stringify(run.error));
    return f.calls.length === 1;
  });
  f.runtime.keepWarm(Date.now() + 600000);
  await f.presence(false);
  await seenAbort.promise;
  assert.equal(f.calls[0]!.signal.reason, "presence");
  assert.equal(f.runtime.used.size, 1);
  assert.equal(f.stops.length, 0);
  const persist = f.gate(),
    persistenceStarted = f.gate();
  const persistence = f.storage.exclusive(async () => {
    persistenceStarted.open();
    await persist.promise;
  });
  await persistenceStarted.promise;
  drain.open();
  await until(() => f.stops.length === 1);
  assert.equal(
    f.runtime.used.size,
    0,
    "A pending durable write must not retain model memory",
  );
  persist.open();
  await persistence;
  await until(async () => (await f.service.run(runID)).state === "paused");
  const paused = await f.service.run(runID);
  assert.deepEqual(f.service.detail(paused).execution, {
    state: "paused",
    reason: "presence",
    resume: "automatic",
  });
  assert.equal(
    paused.messages.filter((m) => m.messageID === original.messageID).length,
    1,
  );
  assert.ok(
    f.service
      .transcript(paused)
      .some((e) => e.message?.content === original.content),
  );
  assert.equal(f.stops[0]!.saveSnapshots, false);
  assert.equal(f.runtime.loadedModel, undefined);
  await f.presence(true);
  await until(async () => (await f.service.run(runID)).state === "completed");
  const completed = await f.service.run(runID);
  assert.equal(
    completed.messages.filter((m) => m.messageID === original.messageID).length,
    1,
  );
  assert.equal(completed.messages.at(-1)?.content, "done");
  assert.equal(attempts, 2);
});

for (const failure of [false, true]) {
  test(`idle residency ignores warm and idle delays when presence ${failure ? "sampling fails" : "returns"}`, async (t) => {
    const f = await setup(t);
    f.runtime.loadedModel = "q";
    f.runtime.keepWarm(Date.now() + 600000);
    f.runtime.scheduleIdle("q");
    if (failure) f.state.sampleFails = true;
    await f.presence(failure, !failure);
    await until(() => f.stops.length === 1);
    assert.equal(f.runtime.loadedModel, undefined);
    assert.equal(f.stops[0]!.saveSnapshots, false);
    if (failure) {
      assert.equal(f.service.presence.samplingHealthy, false);
      assert.equal(f.service.presence.reason, "samplingFailure");
    }
    await Promise.all([
      f.service["dispatch"].tick(),
      f.service["dispatch"].tick(),
    ]);
    await delay(0);
    assert.equal(
      f.stops.length,
      1,
      "Repeated presence ticks cannot unload an already empty runtime",
    );
  });
}

test("an accepted instant agent stays protected before the runner loads its record", async (t) => {
  const f = await setup(t);
  const admission = f.gate();
  const started = f.gate();
  const finish = f.gate();
  const runner: Pick<Runner, "executeRun" | "liveRun"> =
    f.service["dispatch"]["ports"].runner;
  const execute = runner.executeRun.bind(runner);
  let controller: AbortController | undefined;
  runner.executeRun = async (runID, slotID, nextController) => {
    controller = nextController;
    started.open();
    await admission.promise;
    return execute(runID, slotID, nextController);
  };
  f.behavior.generate = async (_input, signal) => {
    await finish.promise;
    signal.throwIfAborted();
    return answer;
  };
  f.runtime.loadedModel = "q";
  const { runID } = await f.service.submit(
    await f.agent("instant"),
    message("explicit request"),
  );
  await started.promise;
  assert.equal(runner.liveRun(runID), undefined);
  t.mock.method(
    f.service["dispatch"]["ports"].compaction,
    "reconcileCompactions",
    async () => {
      throw Error("Unrelated compaction record is unavailable");
    },
  );
  await f.presence(false);
  await delay(0);
  assert.equal(controller!.signal.aborted, false);
  assert.equal(f.stops.length, 0);
  admission.open();
  await until(() => f.calls.length === 1);
  await f.service["dispatch"].tick();
  assert.equal(f.calls[0]!.signal.aborted, false);
  finish.open();
  await until(async () => (await f.service.run(runID)).state === "completed");
  await until(() => f.stops.length === 1);
});

test("a queued interactive chat reuses the model after background cancellation drains", async (t) => {
  const f = await setup(t);
  const drain = f.gate();
  const finish = f.gate();
  f.behavior.generate = async (_input, signal) => {
    if (f.calls.length === 1) {
      await aborted(signal);
      await drain.promise;
      signal.throwIfAborted();
    }
    await finish.promise;
    signal.throwIfAborted();
    return answer;
  };
  await f.service.submit(await f.agent(), message("background"));
  await until(() => f.calls.length === 1);
  await f.presence(false);
  const chat = await f.chat();
  await f.service["dispatch"].tick();
  assert.equal(f.service.chat(chat.requestID).state, "queued");
  const reconcile = t.mock.method(
    f.service["dispatch"]["ports"].compaction,
    "reconcileCompactions",
    async () => {
      throw Error("Unrelated compaction record is unavailable");
    },
  );
  drain.open();
  await until(() => f.runtime.used.size === 0);
  await f.service["dispatch"].tick();
  await delay(0);
  assert.equal(
    f.stops.length,
    0,
    "A known queued chat retains residency even if background planning fails",
  );
  reconcile.mock.restore();
  await f.service["dispatch"].tick();
  await until(() => f.calls.length === 2);
  await f.service["dispatch"].tick();
  assert.equal(f.calls[1]!.signal.aborted, false);
  assert.equal(f.stops.length, 0);
  finish.open();
  await until(() => f.service.chat(chat.requestID).state === "completed");
  await until(() => f.stops.length === 1);
});

test("presence leaves a models test lease alone and releases it after completion", async (t) => {
  const f = await setup(t);
  const finish = f.gate();
  f.behavior.generate = async (_input, signal) => {
    await finish.promise;
    signal.throwIfAborted();
    return answer;
  };
  const work = callOperation(f.service, {
    command: "models test",
    resourceID: "q",
    request: { prompt: "explicit test" },
    dryRun: false,
  });
  await until(() => f.calls.length === 1);
  await f.presence(false);
  assert.equal(f.calls[0]!.signal.aborted, false);
  assert.equal(f.stops.length, 0);
  finish.open();
  await work;
  await until(() => f.stops.length === 1);
});

test("shutdown joins an in-flight presence unload without starting another stop", async (t) => {
  const f = await setup(t);
  const stopped = f.gate();
  f.behavior.stop = async () => stopped.promise;
  f.runtime.loadedModel = "q";
  await f.presence(false);
  await until(() => f.stops.length === 1);
  assert.equal(f.runtime.isBusy(), true);
  await Promise.all([
    f.service["dispatch"].tick(),
    f.service["dispatch"].tick(),
  ]);
  const shutdownReachedRuntime = f.gate();
  const closeRuntime = f.runtime.close.bind(f.runtime);
  t.mock.method(f.runtime, "close", () => {
    shutdownReachedRuntime.open();
    return closeRuntime();
  });
  const closing = f.close();
  // Dispatch.stop may still be draining its pump. Keep eviction in flight until
  // shutdown actually reaches the runtime, rather than assuming microtask order.
  await shutdownReachedRuntime.promise;
  assert.equal(f.stops.length, 1);
  stopped.open();
  await closing;
  assert.equal(f.stops.length, 1);
  assert.equal(f.runtime.isBusy(), false);
});

for (const immediate of [false, true]) {
  test(`aborted model inference ${immediate ? "skips optional snapshots for presence" : "keeps normal snapshot behavior"}`, async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), "nc-presence-client-"));
    const runtime = new LlamaRuntime(
      () =>
        runtimeConfig({
          models: [
            {
              modelID: "q",
              kind: "chat",
              idleUnloadMs: 600000,
              slotSnapshots: { enabled: true },
            },
          ],
        }),
      home,
    );
    const preparation = gate(),
      release = gate();
    let preparing = false,
      releasing = false;
    const snapshots: string[] = [];
    let prunes = 0,
      stops = 0;
    const slotID = runtime.config().slots[0]!.slotID;
    runtime.loadedModel = "q";
    runtime.cache.owners.set(slotID, "durable-run");
    runtime.cache.contextEpochs.set(slotID, 0);
    runtime.prepare = async () => {
      preparing = true;
      await preparation.promise;
    };
    runtime.release = async () => {
      releasing = true;
      await release.promise;
    };
    runtime.cache.slotAction = async (_slot, action) => {
      snapshots.push(action);
    };
    runtime.cache.pruneSnapshots = async () => {
      prunes++;
    };
    runtime.server.stop = async (options?: StopOptions) => {
      assert.equal(runtime.used.size, 0);
      assert.equal(options?.saveSnapshots, false);
      stops++;
      runtime.loadedModel = undefined;
      clearTimeout(runtime.idleTimer);
    };
    t.mock.method(globalThis, "fetch", async () => {
      throw Error("No inference network should be reached");
    });
    t.after(async () => {
      preparation.open();
      release.open();
      clearTimeout(runtime.idleTimer);
      await rm(home, { recursive: true, force: true });
    });
    const controller = new AbortController();
    const result = runtime
      .generate(
        {
          modelID: "q",
          slotID,
          contextID: "durable-run",
          messages: [],
          tools: [],
          sampling: { temperature: 0 },
          maxOutputTokens: 32,
        },
        controller.signal,
      )
      .catch((error: unknown) => error);
    await until(() => preparing);
    runtime.setImmediateUnload(immediate);
    controller.abort("presence");
    await delay(0);
    assert.equal(
      runtime.used.size,
      1,
      "Provisioning owns a slot before inference begins",
    );
    assert.equal(stops, 0);
    preparation.open();
    await until(() => releasing);
    assert.equal(
      runtime.used.size,
      1,
      "HTTP abort must not release a still-processing provider slot",
    );
    assert.equal(stops, 0);
    release.open();
    assert.equal(await result, "presence");
    assert.equal(runtime.used.size, 0);
    if (immediate) await until(() => stops === 1);
    assert.deepEqual(snapshots, immediate ? [] : ["save"]);
    assert.equal(prunes, immediate ? 0 : 1);
    assert.equal(stops, immediate ? 1 : 0);
  });
}

test("presence shutdown skips model cache writes while ordinary shutdown still saves", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nc-presence-server-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = new LlamaRuntime(
    () =>
      runtimeConfig({
        models: [{ modelID: "q", kind: "chat", idleUnloadMs: 600000 }],
      }),
    home,
  );
  const saved: string[] = [];
  runtime.cache.saveLoaded = async () => {
    saved.push("save");
  };
  runtime.cache.pruneSnapshots = async () => {
    saved.push("prune");
  };
  runtime.loadedModel = "q";
  runtime.setImmediateUnload(true);
  await runtime.close();
  assert.deepEqual(saved, []);
  assert.equal(runtime.loadedModel, undefined);
  runtime.setImmediateUnload(false);
  runtime.loadedModel = "q";
  await runtime.close();
  assert.deepEqual(saved, ["save", "prune"]);
});

for (const duringGeneration of [false, true]) {
  test(`presence aborts an optional snapshot already saving during ${duringGeneration ? "generation cleanup" : "idle shutdown"}`, async (t) => {
    const home = await mkdtemp(path.join(tmpdir(), "nc-presence-snapshot-"));
    const runtime = new LlamaRuntime(
      () =>
        runtimeConfig({
          models: [
            {
              modelID: "q",
              kind: "chat",
              idleUnloadMs: 600000,
              slotSnapshots: { enabled: true },
            },
          ],
        }),
      home,
    );
    const slotID = runtime.config().slots[0]!.slotID;
    let saving: AbortSignal | undefined;
    let prunes = 0;
    runtime.loadedModel = "q";
    runtime.cache.owners.set(slotID, "durable-run");
    runtime.cache.contextEpochs.set(slotID, 0);
    runtime.prepare = async () => {};
    runtime.cache.slotAction = async (_slotID, action, signal) => {
      assert.equal(action, "save");
      saving = signal;
      await aborted(signal);
      signal.throwIfAborted();
    };
    runtime.cache.pruneSnapshots = async () => {
      prunes++;
    };
    t.mock.method(
      globalThis,
      "fetch",
      async () =>
        new Response(
          'data: {"choices":[{"index":0,"delta":{"content":"done"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    );
    t.after(async () => {
      runtime.setImmediateUnload(true);
      clearTimeout(runtime.idleTimer);
      await rm(home, { recursive: true, force: true });
    });
    const work = duringGeneration
      ? runtime.generate(
          {
            modelID: "q",
            slotID,
            contextID: "durable-run",
            messages: [],
            tools: [],
            sampling: { temperature: 0 },
            maxOutputTokens: 32,
          },
          new AbortController().signal,
        )
      : runtime.close();
    await until(() => saving !== undefined);
    runtime.setImmediateUnload(true);
    assert.equal(
      saving!.aborted,
      true,
      "Presence must cancel a snapshot already in progress",
    );
    await work;
    await until(() => runtime.loadedModel === undefined);
    assert.equal(prunes, 0);
    assert.equal(runtime.used.size, 0);
  });
}

test("presence eviction resumes after a cache reset releases the runtime", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nc-presence-reset-"));
  const runtime = new LlamaRuntime(
    () =>
      runtimeConfig({
        models: [
          {
            modelID: "q",
            kind: "chat",
            idleUnloadMs: 600000,
            slotSnapshots: { enabled: true },
          },
        ],
      }),
    home,
  );
  t.after(async () => {
    clearTimeout(runtime.idleTimer);
    await rm(home, { recursive: true, force: true });
  });
  runtime.loadedModel = "q";
  const reset = runtime.contextCache("durable-run", true);
  assert.equal(runtime.isBusy(), true);
  runtime.setImmediateUnload(true);
  assert.equal(
    runtime.loadedModel,
    "q",
    "Cache maintenance must finish before release",
  );
  await reset;
  await until(() => runtime.loadedModel === undefined);
  assert.equal(runtime.isBusy(), false);
});

test("an interactive request arriving during eviction waits for the owned stop", async (t) => {
  const f = await setup(t);
  const stopped = f.gate(),
    finish = f.gate();
  f.behavior.stop = async () => stopped.promise;
  f.behavior.generate = async (_input, signal) => {
    await finish.promise;
    signal.throwIfAborted();
    return answer;
  };
  f.runtime.loadedModel = "q";
  await f.presence(false);
  await until(() => f.stops.length === 1);
  const chat = await f.chat();
  await f.service["dispatch"].tick();
  assert.equal(f.service.chat(chat.requestID).state, "queued");
  assert.equal(f.calls.length, 0);
  stopped.open();
  await until(() => !f.runtime.isBusy());
  await f.service["dispatch"].tick();
  await until(() => f.calls.length === 1);
  assert.equal(f.calls[0]!.signal.aborted, false);
  assert.equal(f.stops.length, 1);
  finish.open();
  await until(() => f.service.chat(chat.requestID).state === "completed");
  await until(() => f.stops.length === 2);
});

for (const failure of ["record", "compaction"] as const) {
  test(`an unclassified queued run cannot retain idle model memory after a ${failure} failure`, async (t) => {
    const f = await setup(t);
    await until(() => !f.service["dispatch"]["pumping"]);
    f.runtime.busy = true;
    f.runtime.loadedModel = "q";
    await f.service.submit(await f.agent(), message("pending classification"));
    const ports = f.service["dispatch"]["ports"];
    if (failure === "record") {
      t.mock.method(ports.records, "run", async () => {
        throw Error("Run record unavailable");
      });
    } else {
      t.mock.method(ports.compaction, "reconcileCompactions", async () => {
        throw Error("Compaction record unavailable");
      });
    }
    f.runtime.busy = false;
    await f.presence(false);
    await until(() => f.stops.length === 1);
    assert.equal(f.runtime.loadedModel, undefined);
    assert.equal(f.calls.length, 0);
  });
}
