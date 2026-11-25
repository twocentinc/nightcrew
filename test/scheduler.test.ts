import { runtimeConfig } from "./fixtures.ts";
import { settings, agentDraft } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { Service } from "../dist/engine/service.js";
import { manage as rawmanage } from "../dist/utils/commands/management.js";
const manage: (...args: Parameters<typeof rawmanage>) => Promise<any> =
  rawmanage;
import {
  schedulerSchema,
  executionSlots,
  defaultPlan,
  validatePlan,
  policyPlan,
} from "../dist/engine/scheduling/policy.js";
const message = (content: string) => ({
  messageID: randomUUID(),
  content,
  attachments: [],
});
async function until(fn?: any) {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await delay(10);
  }
  throw Error("Condition timed out");
}
async function setup(
  t: import("node:test").TestContext,
  generate: any,
  schedulerSettings = {},
) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-scheduler-"));
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      scheduler: schedulerSchema.parse(schedulerSettings),
      models: [
        {
          modelID: "q",
          kind: "chat" as const,
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 300000,
        },
      ],
      slots: [],
      hooks: [],
    }),
  );
  const state = { away: true };
  let service!: Service;
  const start = async () => {
    service = new Service(
      new Storage(home),
      { status: () => [], close: async () => {}, generate },
      async () => ({
        state: state.away ? "away" : "present",
        samplingHealthy: true,
        observedAt: new Date().toISOString(),
        reason: "test",
        diagnostic: null,
      }),
    );
    await service.initialize();
  };
  await start();
  t.after(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  const agent = async (id: string, extra = {}) => {
    await service.createAgent(
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
        ...extra,
      }),
    );
  };
  return {
    home,
    state,
    agent,
    get service() {
      return service;
    },
    restart: async () => {
      await service.close();
      await start();
    },
  };
}
const done = {
  text: "done",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
};
test("scheduler batches resident work, eventually switches, and validates external allocations", async () => {
  const settings = schedulerSchema.parse({
    maxConcurrent: 2,
    minResidencyMs: 1000,
    maxWaitMs: 5000,
  });
  const s = {
    now: 10000,
    eligible: true,
    blockers: [],
    residentModelID: "q",
    residentSince: 0,
    settings,
    pending: [
      {
        runID: "a",
        modelID: "q",
        priority: 0,
        modelPriority: 0,
        waitingSince: 9000,
      },
      {
        runID: "b",
        modelID: "g",
        priority: 10,
        modelPriority: 10,
        waitingSince: 9000,
      },
    ],
    active: [] as Array<{ runID: string; modelID: string; slotID: string }>,
    slots: [
      { slotID: "q1", modelID: "q" },
      { slotID: "g1", modelID: "g" },
    ],
  };
  assert.equal(defaultPlan(s).start[0].runID, "a");
  s.pending[1].waitingSince = 0;
  assert.equal(defaultPlan(s).start[0].runID, "b");
  s.active = [{ runID: "active", modelID: "q", slotID: "q1" }];
  assert.deepEqual(defaultPlan(s).pause, ["active"]);
  assert.throws(
    () =>
      validatePlan(s, {
        start: [{ runID: "b", slotID: "g1" }],
        pause: [],
        reason: "bad",
      }),
    /one model/,
  );
  const blocked = { ...s, eligible: false, blockers: ["presence"] };
  assert.throws(
    () =>
      validatePlan(blocked, {
        start: [{ runID: "b", slotID: "g1" }],
        pause: [],
        reason: "bad",
      }),
    /blocked/,
  );
  const hook = {
    executablePath: process.execPath,
    arguments: [
      "-e",
      "process.stdin.resume();process.stdin.on('end',()=>console.log(JSON.stringify({start:[],pause:[],reason:'wait'})))",
    ],
    timeoutMs: 1000,
    failurePolicy: "builtin" as const,
  };
  assert.equal(
    (await policyPlan({ ...s, settings: { ...settings, hook } })).source,
    "hook",
  );
  assert.equal(
    (
      await policyPlan({
        ...s,
        settings: {
          ...settings,
          hook: { ...hook, arguments: ["-e", "console.log('invalid')"] },
        },
      })
    ).source,
    "fallback",
  );
  assert.equal(
    (
      await policyPlan({
        ...s,
        settings: {
          ...settings,
          hook: {
            ...hook,
            arguments: ["-e", "setTimeout(()=>{},10000)"],
            timeoutMs: 100,
            failurePolicy: "hold" as const,
          },
        },
      })
    ).source,
    "hold",
  );
});
test("two background slots run concurrently and instant work waits for both to release", async (t) => {
  let live = 0,
    max = 0,
    released = 0;
  const seen: any[] = [];
  const f = await setup(
    t,
    async (input?: any, signal?: any) => {
      seen.push(input);
      live++;
      max = Math.max(max, live);
      try {
        if (input.messages.at(-1).content === "instant") {
          assert.equal(released, 2);
          return done;
        }
        await new Promise<any>((resolve, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              setTimeout(() => {
                released++;
                reject(Error("aborted"));
              }, 50);
            },
            { once: true },
          ),
        );
        return done;
      } finally {
        live--;
      }
    },
    { maxConcurrent: 2 },
  );
  await f.agent("a");
  await f.agent("b");
  await f.service.submit("a", message("a"));
  await f.service.submit("b", message("b"));
  await until(() => seen.length === 2);
  assert.equal(max, 2);
  assert.notEqual(seen[0].slotID, seen[1].slotID);
  f.state.away = false;
  const accepted = await f.service.submitChat({
    skillIDs: [],
    conversationID: randomUUID(),
    slotID: "instant",
    messages: [
      {
        ...message("instant"),
        role: "user" as const,
        toolCalls: [],
        toolCallID: null,
      },
    ],
    tools: [],
    timeoutMs: 1000,
    maxOutputTokens: 20,
    temperature: 0,
  });
  await until(() => f.service.chat(accepted.requestID).state === "completed");
  assert.equal(max, 2);
});
test("persistent agents keep one run across completion, queued input and restart", async (t) => {
  let release: any;
  const inputs: any[] = [];
  const f = await setup(t, async (input?: any, signal?: any) => {
    inputs.push(input);
    if (input.messages.at(-1).content === "one")
      await new Promise<any>((r, reject) => {
        release = r;
        signal.addEventListener("abort", () => reject(Error("abort")), {
          once: true,
        });
      });
    return done;
  });
  await f.agent("persistent", { contextMode: "persistent" });
  const first = await f.service.submit("persistent", message("one"));
  await until(() => !!release);
  const secondMessage = message("two");
  const second = await f.service.submit("persistent", secondMessage);
  assert.equal(second.runID, first.runID);
  assert.equal((await f.service.run(first.runID)).pendingInputs.length, 1);
  assert.equal(
    (await f.service.submit("persistent", secondMessage)).replayed,
    true,
  );
  release();
  await until(
    async () =>
      inputs.length === 2 &&
      (await f.service.run(first.runID)).state === "completed",
  );
  assert.deepEqual(
    inputs[1].messages
      .filter((m?: any) => m.role === "user")
      .map((m?: any) => m.content),
    ["one", "two"],
  );
  await f.restart();
  const third = await f.service.submit("persistent", message("three"));
  assert.equal(third.runID, first.runID);
  await until(
    async () => (await f.service.run(first.runID)).state === "completed",
  );
  const run = await f.service.run(first.runID);
  assert.equal(run.segment, 2);
  assert.equal(run.messages.filter((m?: any) => m.role === "user").length, 3);
  assert.equal(
    [...f.service.storage.summaries.values()].filter(
      (r) => r.agentID === "persistent",
    ).length,
    1,
  );
  assert.ok(inputs.every((i) => i.contextID === inputs[0].contextID));
});
test("time slices pause without failing and timer admission has no catch-up", async (t) => {
  let count = 0;
  const f = await setup(t, async (input?: any, signal?: any) => {
    count++;
    if (count === 1)
      await new Promise<any>((resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("yield")), {
          once: true,
        }),
      );
    return done;
  });
  await f.agent("sliced", { contextMode: "persistent", timeSliceMs: 100 });
  const accepted = await f.service.submit("sliced", message("work"));
  await until(
    async () => (await f.service.run(accepted.runID)).state === "completed",
  );
  const run = await f.service.run(accepted.runID);
  assert.ok(run.events.some((e?: any) => e.type === "paused"));
  assert.ok(run.activeMs >= 90);
  assert.equal(run.segment, 0);
  await manage(f.service, {
    command: "triggers create",
    request: {
      trigger: {
        triggerID: "timer",
        name: "timer",
        agentID: "sliced",
        enabled: true,
        schedule: { type: "interval" as const, everyMs: 60000 },
      },
    },
  });
  await f.service["dispatch"]["timers"]["dispatchTimers"]();
  assert.ok(
    f.service["dispatch"]["timers"]["triggerDue"].get("timer").at > Date.now(),
  );
  f.service["dispatch"]["timers"]["triggerDue"].set("timer", {
    revision: 1,
    at: Date.now() - 100000,
  });
  await f.service["dispatch"]["timers"]["dispatchTimers"]();
  assert.equal((await f.service.run(run.runID)).segment, 0);
  f.service["dispatch"]["timers"]["triggerDue"].set("timer", {
    revision: 1,
    at: Date.now() - 100,
  });
  await f.service["dispatch"]["timers"]["dispatchTimers"]();
  await until(async () => (await f.service.run(run.runID)).segment === 1);
  assert.equal(f.service.storage.summaries.size, 1);
});

test("cancelling a persistent run does not execute its pending inputs", async (t) => {
  const inputs: any[] = [];
  const f = await setup(t, async (input?: any, signal?: any) => {
    inputs.push(input);
    if (input.messages.at(-1).content === "first")
      await new Promise<any>((resolve, reject) =>
        signal.addEventListener("abort", () => reject(Error("cancel")), {
          once: true,
        }),
      );
    return done;
  });
  await f.agent("persistent", { contextMode: "persistent" });
  const first = await f.service.submit("persistent", message("first"));
  await until(() => inputs.length === 1);
  const queued = message("cancelled-input");
  await f.service.submit("persistent", queued);
  await f.service.cancelRun(first.runID);
  await delay(30);
  assert.equal(inputs.length, 1);
  assert.equal(
    (await f.service.run(first.runID)).pendingInputs[0].cancelled,
    true,
  );
  assert.equal((await f.service.submit("persistent", queued)).replayed, true);
  const next = await f.service.submit("persistent", message("new"));
  assert.equal(next.runID, first.runID);
  await until(
    async () => (await f.service.run(first.runID)).state === "completed",
  );
  assert.equal(inputs.length, 2);
  assert.ok(
    !inputs[1].messages.some((m?: any) => m.content === "cancelled-input"),
  );
});
test("scheduler partial updates preserve existing limits and hook configuration", async (t) => {
  const f = await setup(t, async () => done, {
    maxConcurrent: 3,
    contextTokens: 8192,
    maxWaitMs: 123456,
  });
  const { requestSchemas } = await import("../dist/utils/commands/inputs.js");
  const request: any = requestSchemas["config update"].parse({
    expectedRevision: f.service.storage.store.config.revision,
    changes: { scheduler: { timersEnabled: false } },
  });
  assert.deepEqual(request.changes, { scheduler: { timersEnabled: false } });
  const out = await manage(f.service, { command: "config update", request });
  assert.equal(out.config.scheduler.maxConcurrent, 3);
  assert.equal(out.config.scheduler.contextTokens, 8192);
  assert.equal(out.config.scheduler.maxWaitMs, 123456);
  const config: any = requestSchemas["config update"].parse({
    expectedRevision: 1,
    changes: { interactionCooldownMs: 0 },
  });
  assert.deepEqual(config.changes, { interactionCooldownMs: 0 });
  const model: any = requestSchemas["models update"].parse({
    expectedRevision: 1,
    changes: { idleUnloadMs: 123 },
  });
  assert.deepEqual(model.changes, { idleUnloadMs: 123 });
});

test("only the designated chat model reserves an instant slot", () => {
  const config = {
    scheduler: schedulerSchema.parse({ instantModelID: "b" }),
    slots: [],
    models: [
      { modelID: "a", kind: "chat" as const },
      { modelID: "b", kind: "chat" as const },
      { modelID: "speech", kind: "audio" as const },
    ],
  };
  const slots = executionSlots(runtimeConfig(config));
  assert.equal(slots.filter((s) => s.modelID === "b").length, 2);
  assert.deepEqual(
    slots.filter((s) => s.instant).map((s) => s.modelID),
    ["b"],
  );
  assert.equal(slots.filter((s) => s.modelID === "a").length, 1);
  assert.equal(slots.filter((s) => s.modelID === "speech").length, 1);
});
test("instant inference rejects other models and invalid configuration", async (t) => {
  const f = await setup(t, async () => ({ content: "ok", toolCalls: [] }));
  await assert.rejects(
    f.service.submitChat({ modelID: "other" } as Parameters<
      typeof f.service.submitChat
    >[0]),
    /invalid_instant_model/,
  );
  await assert.rejects(
    manage(f.service, {
      command: "config update",
      request: {
        expectedRevision: f.service.storage.store.config.revision,
        changes: { scheduler: { instantModelID: "missing" } },
      },
    }),
    /Instant model/,
  );
});

test("default background agents borrow the same slot serially with fresh run contexts", async (t) => {
  const seen: any[] = [];
  let active = 0,
    max = 0;
  const f = await setup(t, async (input?: any) => {
    seen.push(input);
    active++;
    max = Math.max(max, active);
    await delay(30);
    active--;
    return done;
  });
  await f.agent("one");
  await f.agent("two");
  const a = await f.service.submit("one", message("one"));
  const b = await f.service.submit("two", message("two"));
  await until(() => seen.length === 2 && active === 0);
  assert.equal(max, 1);
  assert.equal(seen[0].slotID, seen[1].slotID);
  assert.notEqual(seen[0].contextID, seen[1].contextID);
  assert.ok(seen.every((i) => i.persistContext === false));
  assert.notEqual(a.runID, b.runID);
});

test("runs pause interrupts active generation and holds across restart until resumed", async (t) => {
  let calls = 0;
  const f = await setup(t, async (input?: any, signal?: any) => {
    calls++;
    if (calls > 1) return done;
    return new Promise<any>((resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("paused")), {
        once: true,
      }),
    );
  });
  await f.agent("pausable");
  const accepted = await f.service.submit("pausable", message("work"));
  await until(() => calls === 1);
  let run = await f.service.run(accepted.runID);
  const paused = await manage(f.service, {
    command: "runs pause",
    resourceID: run.runID,
    request: { expectedRevision: run.revision },
  });
  assert.equal(paused.run.execution.state, "paused");
  assert.equal(paused.run.execution.resume, "manual");
  assert.equal(paused.run.execution.reason, "manualStop");
  await f.restart();
  await delay(100);
  assert.equal(calls, 1);
  run = await f.service.run(run.runID);
  await manage(f.service, {
    command: "runs resume",
    resourceID: run.runID,
    request: { expectedRevision: run.revision },
  });
  await until(
    async () => (await f.service.run(run.runID)).state === "completed",
  );
  assert.equal(calls, 2);
});

test("fresh runs accept a reply after cancellation without replaying cancelled work", async (t) => {
  const inputs: any[] = [];
  const f = await setup(t, async (input?: any, signal?: any) => {
    inputs.push(input);
    if (input.messages.at(-1).content === "first") {
      await new Promise<any>((resolve) =>
        signal.addEventListener("abort", resolve, { once: true }),
      );
      signal.throwIfAborted();
    }
    return done;
  });
  await f.agent("daily", { contextMode: "fresh" });
  const first = await f.service.submit("daily", message("first"));
  await until(() => inputs.length === 1);
  await f.service.cancelRun(first.runID);
  const cancelled = await f.service.run(first.runID);
  assert.equal(cancelled.state, "cancelled");
  cancelled.messages.push({
    messageID: randomUUID(),
    role: "assistant" as const,
    content: "",
    attachments: [],
    toolCalls: [{ callID: "unfinished", name: "mutation", arguments: "{}" }],
    toolCallID: null,
  });
  cancelled.held = true;
  const childID = randomUUID();
  await f.service.storage.write(
    {
      ...structuredClone(cancelled),
      runID: childID,
      state: "paused",
      parentRunID: first.runID,
      compaction: null,
      messages: [{ ...cancelled.messages[0], messageID: randomUUID() }],
      events: [],
    },
    true,
  );
  cancelled.compaction = {
    retries: 0,
    requestID: randomUUID(),
    coveredThrough: 1,
    targetTokens: 100,
    inputTokens: 200,
    childRunID: childID,
    status: "failed",
    summary: null,
    handler: null,
  };
  await f.service.storage.write(cancelled);
  await f.restart();
  const next = message("continue");
  await f.service.submit(first.runID, next, true, true);
  assert.equal((await f.service.run(first.runID)).state, "cancelled");
  assert.equal((await f.service.run(childID)).state, "paused");
  const accepted = await f.service.submit(first.runID, next, true);
  assert.equal(accepted.runID, first.runID);
  await until(
    async () => (await f.service.run(first.runID)).state === "completed",
  );
  const run = await f.service.run(first.runID);
  assert.equal(run.segment, 1);
  assert.equal(run.compaction, null);
  assert.equal((await f.service.run(childID)).state, "cancelled");
  assert.equal(run.held, false);
  assert.equal(inputs.length, 2);
  const result = inputs[1].messages.find(
    (m?: any) => m.toolCallID === "unfinished",
  );
  assert.equal(JSON.parse(result.content).error.outcome, "unknown");
  assert.equal(
    (await f.service.submit(first.runID, next, true)).replayed,
    true,
  );
  assert.equal(
    run.messages.filter((m?: any) => m.messageID === next.messageID).length,
    1,
  );
  assert.ok(run.events.some((e?: any) => e.type === "cancelled"));
});

test("models unload cancels and settles interactive work before closing, then allows the same run to continue", async (t) => {
  let entered = false,
    stopped = false,
    block = true,
    closes = 0,
    resident = true;
  const f = await setup(t, async (_input?: any, signal?: any) => {
    if (block) {
      entered = true;
      await new Promise<any>((resolve, reject) =>
        signal.addEventListener(
          "abort",
          () =>
            setTimeout(() => {
              stopped = true;
              reject(Error("cancelled"));
            }, 20),
          { once: true },
        ),
      );
    }
    return done;
  });
  f.state.away = false;
  const next = structuredClone(f.service.storage.store);
  next.config.slots = executionSlots(runtimeConfig(next.config));
  await f.service.storage.exclusive(() => f.service.storage.saveConfig(next));
  await f.agent("interactive", {
    enabled: false,
    contextMode: "fresh",
    slotID: next.config.slots.find((s?: any) => s.instant)!.slotID,
  });
  f.service.runtime.status = () => [
    { modelID: "q", state: resident ? "ready" : "unloaded" },
  ];
  f.service.runtime.close = async () => {
    assert.equal(stopped, true);
    closes++;
    resident = false;
  };
  const run = await f.service.submit("interactive", message("first"));
  await until(() => entered);
  const preview = await manage(f.service, {
    command: "models unload",
    request: {},
    dryRun: true,
  });
  assert.equal(preview.changed, false);
  assert.equal(closes, 0);
  const result = await manage(f.service, {
    command: "models unload",
    request: {},
  });
  assert.deepEqual(result.cancelledRunIDs, [run.runID]);
  assert.equal(closes, 1);
  assert.equal((await f.service.run(run.runID)).state, "cancelled");
  assert.equal(
    (await manage(f.service, { command: "models unload", request: {} }))
      .changed,
    false,
  );
  block = false;
  const reply = await f.service.submit(run.runID, message("continue"), true);
  assert.equal(reply.runID, run.runID);
  await until(
    async () => (await f.service.run(run.runID)).state === "completed",
  );
});

test("models unload refuses unrelated active background work", async (t) => {
  let entered = false;
  const f = await setup(t, async (_input?: any, signal?: any) => {
    entered = true;
    await new Promise<any>((resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("abort")), {
        once: true,
      }),
    );
    return done;
  });
  await f.agent("background");
  const run = await f.service.submit("background", message("work"));
  await until(() => entered);
  await assert.rejects(
    manage(f.service, { command: "models unload", request: {} }),
    (e: any) => e.code === "instant_model_busy_with_background_work",
  );
  assert.equal((await f.service.run(run.runID)).state, "running");
});

test("explicit capability refresh preserves daily history, snapshots and stopped state", async (t) => {
  const f = await setup(t, async () => done);
  await f.agent("interactive", {
    mode: "agent-loop",
    contextMode: "fresh",
    enabled: false,
  });
  const accepted = await f.service.submit("interactive", message("hello"));
  await until(
    async () => (await f.service.run(accepted.runID)).state === "completed",
  );
  const before = await f.service.run(accepted.runID);
  await manage(f.service, {
    command: "tools create",
    request: {
      tool: {
        toolID: "current_time",
        description: "clock",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
        executablePath: process.execPath,
        argv: ["-e", 'console.log("clock")'],
        timeoutMs: 1000,
      },
    },
  });
  const agent = f.service.agent("interactive");
  await f.service.patchAgent("interactive", agent.revision, {
    toolIDs: ["current_time"],
  });
  const command = {
    command: "runs refresh",
    resourceID: accepted.runID,
    request: { expectedRevision: before.revision },
  };
  await manage(f.service, { ...command, dryRun: true });
  assert.deepEqual((await f.service.run(accepted.runID)).agent.toolIDs, []);
  const result = await manage(f.service, command);
  assert.equal(result.changed, true);
  const after = await f.service.run(accepted.runID);
  assert.deepEqual(after.messages, before.messages);
  assert.equal(after.state, before.state);
  assert.deepEqual(after.agent.toolIDs, ["current_time"]);
  assert.deepEqual(
    after.capabilityRefreshes[0].previousTools,
    before.toolSnapshots,
  );
  assert.equal(after.capabilityRefreshes.length, 1);
  await assert.rejects(
    manage(f.service, command),
    (e: any) => e.code === "revision_conflict",
  );
  await f.restart();
  assert.deepEqual((await f.service.run(accepted.runID)).agent.toolIDs, [
    "current_time",
  ]);
  f.state.away = false;
  const next = await f.service.submit("interactive", message("queued"));
  const queued = await f.service.run(next.runID);
  await assert.rejects(
    manage(f.service, {
      command: "runs refresh",
      resourceID: next.runID,
      request: { expectedRevision: queued.revision },
    }),
    (e: any) => e.code === "run_not_idle",
  );
});

test("instant delete settles active work and forgets completed results; dry run preserves them", async (t) => {
  let started = false;
  const f = await setup(t, async (_input: unknown, signal: AbortSignal) => {
    started = true;
    await new Promise<void>((_resolve, reject) =>
      signal.addEventListener("abort", () => reject(Error("cancelled")), {
        once: true,
      }),
    );
    return { text: "unreachable" };
  });
  const accepted = await f.service.submitChat({
    skillIDs: [],
    conversationID: randomUUID(),
    slotID: "instant",
    messages: [
      { ...message("hello"), role: "user", toolCalls: [], toolCallID: null },
    ],
    tools: [],
    timeoutMs: 10000,
    maxOutputTokens: 20,
    temperature: 0,
  });
  await until(() => started);
  assert.equal(
    (await f.service.deleteChat(accepted.requestID, true)).changed,
    false,
  );
  assert.equal(f.service.chat(accepted.requestID).state, "running");
  assert.equal(
    (await f.service.deleteChat(accepted.requestID)).status,
    "deleted",
  );
  assert.throws(
    () => f.service.chat(accepted.requestID),
    /request_unavailable/,
  );
  assert.equal(f.service.status().queue.length, 0);
  const g = await setup(t, async () => ({
    text: "hello",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
  }));
  const done = await g.service.submitChat({
    skillIDs: [],
    conversationID: randomUUID(),
    slotID: "instant",
    messages: [
      { ...message("hello"), role: "user", toolCalls: [], toolCallID: null },
    ],
    tools: [],
    timeoutMs: 10000,
    maxOutputTokens: 20,
    temperature: 0,
  });
  await until(() => g.service.chat(done.requestID).state === "completed");
  await g.service.deleteChat(done.requestID);
  assert.throws(() => g.service.chat(done.requestID), /request_unavailable/);
});
