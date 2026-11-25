import { settings, agentDraft } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
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
  nextFireAt,
  scheduleSchema,
} from "../dist/engine/scheduling/schedule.js";

async function fixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-trigger-"));
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      models: [
        {
          modelID: "qwen",
          kind: "chat" as const,
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 0,
        },
      ],
      slots: [
        {
          slotID: "instant",
          modelID: "qwen",
          index: 0,
          contextTokens: 1024,
          instant: true,
        },
        {
          slotID: "background",
          modelID: "qwen",
          index: 1,
          contextTokens: 1024,
          instant: false,
        },
      ],
      hooks: [],
    }),
  );
  const calls: any[] = [],
    state = { away: false };
  let service!: Service;
  const start = async () => {
    service = new Service(
      new Storage(home),
      {
        status: () => [],
        close: async () => {},
        generate: async (input) => {
          calls.push(input);
          return {
            text: "done",
            toolCalls: [],
            usage: { inputTokens: 1, outputTokens: 1 },
          };
        },
      },
      async () => ({
        state: state.away ? "away" : "present",
        reason: "test",
        observedAt: new Date().toISOString(),
        samplingHealthy: true,
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
  await service.createAgent(
    agentDraft.parse({
      agentID: "reviewer",
      name: "reviewer",
      systemPrompt: "Review",
      mode: "single-turn",
      modelID: "qwen",
      slotID: "background",
      enabled: true,
      toolIDs: [],
      skillIDs: [],
      timeoutMs: 30000,
      thinking: false,
      temperature: 0,
      maxOutputTokens: 32,
    }),
  );
  const invoke = (
    command: string,
    resourceID: string | undefined = undefined,
    request = {},
    extra = {},
  ) => manage(service, { command, resourceID, request, ...extra });
  const create = (triggerID?: any, queuePolicy = "skip") =>
    invoke("triggers create", undefined, {
      trigger: {
        triggerID,
        name: triggerID,
        agentID: "reviewer",
        enabled: true,
        queuePolicy,
        schedule: { type: "interval" as const, everyMs: 60000 },
        message: { content: "check", attachments: [] },
      },
    });
  return {
    home,
    calls,
    state,
    get service() {
      return service;
    },
    invoke,
    create,
    restart: async () => {
      await service.close();
      await start();
    },
  };
}
async function until(fn?: any) {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await delay(20);
  }
  throw Error("Timed out");
}

test("fixed intervals and cron use explicit zones, skip missed ticks, and handle DST", () => {
  const anchor = "2026-01-01T00:00:00.000Z";
  assert.equal(
    nextFireAt(
      { type: "interval" as const, everyMs: 60000 },
      anchor,
      Date.parse("2026-01-01T00:10:10Z"),
    ),
    "2026-01-01T00:11:00.000Z",
  );
  assert.equal(nextFireAt({ type: "manual" as const }, anchor), null);
  const cron = {
    type: "cron" as const,
    expression: "30 2 * * *",
    timezone: "America/New_York",
  };
  assert.equal(
    nextFireAt(cron, anchor, Date.parse("2026-03-08T06:59:00Z")),
    "2026-03-08T07:30:00.000Z",
  );
  assert.equal(
    nextFireAt(
      { ...cron, expression: "30 1 * * *" },
      anchor,
      Date.parse("2026-11-01T05:30:00Z"),
    ),
    "2026-11-02T06:30:00.000Z",
  );
  assert.equal(
    nextFireAt(
      {
        type: "cron" as const,
        expression: "*/15 9-17 * * 1-5",
        timezone: "UTC",
      },
      anchor,
      Date.parse("2026-01-02T09:00:00Z"),
    ),
    "2026-01-02T09:15:00.000Z",
  );
  for (const expression of [
    "* * * * * * *",
    "61 * * * *",
    "*/0 * * * *",
    "0 0 32 * *",
  ])
    assert.equal(
      scheduleSchema.safeParse({ ...cron, expression }).success,
      false,
    );
  assert.equal(
    scheduleSchema.safeParse({ ...cron, timezone: "invalid/zone" }).success,
    false,
  );
});

test("trigger CRUD keeps revisions and anchors, rejects dangling agents, and leaves accepted work intact", async (t) => {
  const f = await fixture(t);
  const created = await f.create("timer");
  const original = created.item;
  const renamed = await f.invoke("triggers update", "timer", {
    expectedRevision: 1,
    changes: { name: "renamed" },
  });
  assert.equal(renamed.item.enabled, true);
  assert.equal(renamed.item.queuePolicy, "skip");
  assert.deepEqual(renamed.item.message, original.message);
  assert.equal(renamed.item.anchorAt, original.anchorAt);
  await assert.rejects(
    f.invoke("triggers update", "timer", {
      expectedRevision: 1,
      changes: { name: "stale" },
    }),
    /revision_conflict/,
  );
  const fired = await f.invoke("triggers fire", "timer", {
    occurrenceID: randomUUID(),
  });
  assert.equal(fired.outcome, "queued");
  assert.equal(
    (await f.invoke("triggers get", "timer")).item.anchorAt,
    original.anchorAt,
  );
  const info = (await f.invoke("triggers get", "timer")).item;
  assert.ok(info.nextFireAt);
  assert.equal(info.automaticDispatchEnabled, true);
  assert.ok(info.blockers.includes("unfinished_trigger_run"));
  await assert.rejects(
    f.invoke(
      "agents delete",
      "reviewer",
      { expectedRevision: 1 },
      { yes: true },
    ),
    /trigger agent reference/,
  );
  await f.invoke("triggers update", "timer", {
    expectedRevision: 2,
    changes: { enabled: false },
  });
  assert.equal((await f.invoke("triggers get", "timer")).item.nextFireAt, null);
  await assert.rejects(f.invoke("triggers fire", "timer"), /trigger_disabled/);
  await f.invoke(
    "triggers delete",
    "timer",
    { expectedRevision: 3 },
    { yes: true },
  );
  const run = await f.service.run(fired.runID);
  assert.equal(run.state, "queued");
  assert.equal(run.triggerSource!.definition.name, "renamed");
});

test("trigger admission deduplicates, skips, coalesces only pending input and persists holds across restart", async (t) => {
  const f = await fixture(t);
  await f.create("timer");
  const occurrenceID = randomUUID();
  const first = await f.invoke("triggers fire", "timer", { occurrenceID });
  assert.equal(
    (await f.invoke("triggers fire", "timer", { occurrenceID })).outcome,
    "replayed",
  );
  await assert.rejects(
    f.invoke("triggers fire", "timer", {
      occurrenceID,
      message: { content: "changed", attachments: [] },
    }),
    /message_conflict/,
  );
  const skippedID = randomUUID();
  assert.equal(
    (await f.invoke("triggers fire", "timer", { occurrenceID: skippedID }))
      .outcome,
    "skipped",
  );
  let run = await f.service.run(first.runID);
  await f.invoke("runs pause", run.runID, { expectedRevision: run.revision });
  await f.restart();
  run = await f.service.run(first.runID);
  assert.equal(run.held, true);
  assert.equal(run.state, "paused");
  await f.invoke("runs cancel", run.runID);
  assert.equal(
    (await f.invoke("triggers fire", "timer", { occurrenceID: skippedID }))
      .outcome,
    "queued",
  );
  await f.create("merged", "coalesce");
  const a = await f.invoke("triggers fire", "merged", {
    occurrenceID: randomUUID(),
  });
  const latest = randomUUID();
  assert.equal(
    (
      await f.invoke("triggers fire", "merged", {
        occurrenceID: latest,
        message: { content: "latest", attachments: [] },
      })
    ).outcome,
    "coalesced",
  );
  run = await f.service.run(a.runID);
  assert.equal(run.messages.filter((m?: any) => m.role === "user").length, 2);
  const before = await readFile(
    path.join(f.home, "runs", a.runID, "state.json"),
  );
  await f.invoke(
    "triggers fire",
    "merged",
    { message: { content: "dry", attachments: [] } },
    { dryRun: true },
  );
  assert.deepEqual(
    await readFile(path.join(f.home, "runs", a.runID, "state.json")),
    before,
  );
  assert.equal(
    (await f.invoke("triggers fire", "merged", { occurrenceID: latest }))
      .outcome,
    "replayed",
  );
  // Hold all other work, then release only the coalesced run while away.
  for (const item of (await f.invoke("runs list")).items.filter((r?: any) =>
    ["queued", "paused"].includes(r.execution.state),
  )) {
    await f.invoke("runs pause", item.runID, {
      expectedRevision: item.revision,
    });
  }
  f.state.away = true;
  f.service.presence = { ...f.service.presence, state: "away" };
  run = await f.service.run(a.runID);
  await f.invoke("runs resume", a.runID, { expectedRevision: run.revision });
  await until(async () => (await f.service.run(a.runID)).state === "completed");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(
    f.calls[0].messages
      .filter((m?: any) => m.role === "user")
      .map((m?: any) => m.content),
    ["latest"],
  );
  run = await f.service.run(a.runID);
  await assert.rejects(
    f.invoke("runs pause", a.runID, { expectedRevision: run.revision }),
    /run_not_pending/,
  );
});

test("concurrent skip firing admits one run and enqueue preserves distinct submissions", async (t) => {
  const f = await fixture(t);
  await f.create("skip");
  const outcomes = await Promise.all(
    Array.from({ length: 5 }, () =>
      f.invoke("triggers fire", "skip", { occurrenceID: randomUUID() }),
    ),
  );
  assert.equal(outcomes.filter((x) => x.outcome === "queued").length, 1);
  assert.equal(outcomes.filter((x) => x.outcome === "skipped").length, 4);
  await f.create("enqueue", "enqueue");
  const runs = await Promise.all(
    Array.from({ length: 3 }, () =>
      f.invoke("triggers fire", "enqueue", { occurrenceID: randomUUID() }),
    ),
  );
  assert.equal(new Set(runs.map((x) => x.runID)).size, 3);
  const run = await f.service.run(runs[0].runID);
  await assert.rejects(
    f.invoke("runs pause", run.runID, { expectedRevision: run.revision + 1 }),
    /revision_conflict/,
  );
});

test("cron syntax and calendar validation follow cron-parser", () => {
  const anchor = "2026-01-01T00:00:00.000Z";
  for (const expression of ["@hourly", "0 9 * JAN MON", "*/10 * * * * *"])
    assert.equal(
      scheduleSchema.safeParse({ type: "cron", expression, timezone: "UTC" })
        .success,
      true,
    );
  assert.equal(
    scheduleSchema.safeParse({
      type: "cron",
      expression: "0 0 30 2 *",
      timezone: "UTC",
    }).success,
    false,
  );
  assert.equal(
    nextFireAt(
      { type: "cron", expression: "*/10 * * * * *", timezone: "UTC" },
      anchor,
      Date.parse(anchor),
    ),
    "2026-01-01T00:00:10.000Z",
  );
  assert.equal(
    nextFireAt(
      { type: "cron", expression: "0 9 * * *", timezone: "Asia/Kathmandu" },
      anchor,
      Date.parse(anchor),
    ),
    "2026-01-01T03:15:00.000Z",
  );
});
