import { settings } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  rm,
  readFile,
  writeFile,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { Service } from "../dist/engine/service.js";
import { manage as rawmanage } from "../dist/utils/commands/management.js";
const manage: (...args: Parameters<typeof rawmanage>) => Promise<any> =
  rawmanage;
import { runProjectionSchema, decodeRun } from "../dist/schemas/run.js";
import { startupLogs } from "../dist/server/startup.js";

async function fixture(t: import("node:test").TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), "nc-inspect-"));
  const home = path.join(root, "home");
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      models: [],

      hooks: [],
    }),
  );
  const storage = new Storage(home);
  await storage.initialize();
  t.after(async () => {
    await storage.close();
    await rm(root, { recursive: true, force: true });
  });
  const service = new Service(
    storage,
    {
      status: () => [],
      generate: () => {
        throw Error("Must not infer");
      },
      close: async () => {},
    },
    async () => {
      throw Error("Must not sample");
    },
  );
  const makeRun = async (runID: string, state = "completed") => {
    const at = "2026-01-01T00:00:00.000Z";
    const messageID = randomUUID();
    const outputID = randomUUID();
    const run = decodeRun(
      runProjectionSchema.parse({
        version: 4,
        runID,
        revision: 1,
        createdAt: at,
        updatedAt: at,
        agent: {
          agentID: "reviewer",
          name: "reviewer",
          revision: 1,
          systemPrompt: "Test",
          mode: "singleTurn",
          modelID: "test",
          executionClass: "background",
          skillIDs: [],
          toolIDs: [],
          timeoutMs: 1000,
          enabled: false,
          createdAt: at,
          updatedAt: at,
        },
        skills: [],
        toolSnapshots: [],
        turnID: messageID,
        execution: { state },
        activeMs: 0,
        messages: [
          {
            messageID,
            role: "user" as const,
            content: "hello world",
            attachments: [
              {
                name: "note.txt",
                mediaType: "text/plain" as const,
                dataBase64: Buffer.from("attachment needle").toString("base64"),
              },
            ],
            toolCalls: [],
            toolCallID: null,
          },
          ...(state === "completed"
            ? [
                {
                  messageID: outputID,
                  role: "assistant",
                  content: "result needle",
                  attachments: [],
                  toolCalls: [],
                  toolCallID: null,
                },
              ]
            : []),
        ],
        events: [
          {
            eventID: randomUUID(),
            sequence: 1,
            at,
            type: "message" as const,
            turnID: messageID,
            data: { messageID },
          },
          {
            eventID: randomUUID(),
            sequence: 2,
            at,
            type: state === "completed" ? "completed" : "queued",
            turnID: messageID,
            data: state === "completed" ? { messageID: outputID } : {},
          },
        ],
        result: state === "completed" ? "result needle" : null,
        hookReceipts: [],
      }),
    );
    await storage.write(run, true);
    return run;
  };
  return { root, home, storage, service, makeRun };
}
test("run inspection pages are stable, filtered, replayable and query-bound", async (t) => {
  const { service, makeRun } = await fixture(t);
  await makeRun("a");
  await makeRun("b");
  await makeRun("c", "queued");
  const list = (request?: any) =>
    manage(service, { command: "runs list", request });
  const first = await list({
    agentID: "reviewer",
    state: "completed",
    limit: 1,
  });
  assert.equal(first.items[0].runID, "a");
  await makeRun("aa");
  const second = await list({
    agentID: "reviewer",
    state: "completed",
    limit: 1,
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0].runID, "b");
  assert.equal(second.nextCursor, null);
  assert.deepEqual(
    second,
    await list({
      agentID: "reviewer",
      state: "completed",
      limit: 1,
      cursor: first.nextCursor,
    }),
  );
  await assert.rejects(
    list({ limit: 1, cursor: first.nextCursor }),
    /cursor_query_mismatch/,
  );
  await assert.rejects(list({ cursor: "expired" }), /cursor_expired/);
  const page = await manage(service, {
    command: "runs transcript",
    resourceID: "a",
    request: { limit: 1 },
  });
  assert.equal(page.items[0].sequence, 1);
  assert.ok(page.nextCursor);
  const search = await manage(service, {
    command: "runs list",
    request: { query: "attachment needle", state: "queued" },
  });
  assert.deepEqual(
    search.items.map((x?: any) => x.runID),
    ["c"],
  );
  const result = await manage(service, {
    command: "runs list",
    request: { query: "result needle", limit: 1 },
  });
  assert.equal(result.items[0].eventSequence, 2);
  assert.ok(result.nextCursor);
  await assert.rejects(
    manage(service, { command: "runs list", request: { query: "" } }),
  );
});
test("exports preserve committed source, refuse overwrite, verify checksums and work offline", async (t) => {
  const { root, home, storage, service, makeRun } = await fixture(t);
  await makeRun("active", "queued");
  const source = path.join(home, "runs/active/state.json");
  const before = await readFile(source);
  const destination = path.join(root, "bundle");
  const request = {
    command: "runs export",
    resourceID: "active",
    request: { destination },
  };
  assert.equal(
    (await manage(service, { ...request, dryRun: true })).changed,
    false,
  );
  await assert.rejects(stat(destination), { code: "ENOENT" });
  const exported = await manage(service, request);
  assert.equal(exported.lastEventSequence, 2);
  assert.equal((await stat(destination)).mode & 0o777, 0o700);
  await assert.rejects(manage(service, request), /already exists/);
  const verify = () =>
    manage(service, {
      command: "runs verify",
      resourceID: "active",
      request: { bundle: destination },
    });
  assert.equal((await verify()).valid, true);
  assert.equal(
    (await manage(service, { command: "runs verify", resourceID: "active" }))
      .valid,
    true,
  );
  assert.deepEqual(await readFile(source), before);
  await writeFile(path.join(destination, "result.json"), "{}");
  const broken = await verify();
  assert.equal(broken.valid, false);
  assert.match(broken.errors[0], /Checksum mismatch/);
  const invalid = JSON.parse(before.toString());
  invalid.events.find((e: any) => e.type === "messageRecorded").data.messageID =
    randomUUID();
  await writeFile(source, JSON.stringify(invalid));
  assert.equal(
    (await manage(service, { command: "runs verify", resourceID: "active" }))
      .valid,
    false,
  );
  await writeFile(source, before);
  await storage.close();
  const cli = new URL("../dist/cli.js", import.meta.url).pathname;
  const result = spawnSync(
    process.execPath,
    [cli, "runs", "verify", "active", "--home", home],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).result.valid, true);
  const exportedOffline = spawnSync(
    process.execPath,
    [cli, "runs", "export", "active", "--home", home, "--request", "-"],
    {
      input: JSON.stringify({ destination: path.join(root, "offline") }),
      encoding: "utf8",
    },
  );
  assert.equal(
    exportedOffline.status,
    0,
    exportedOffline.stdout + exportedOffline.stderr,
  );
  assert.deepEqual(await readFile(source), before);
});
test("log pagination is bounded, replayable, and rejects rotation or changed queries", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "nc-logs-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "logs"));
  const log = path.join(root, "logs/daemon.jsonl");
  await writeFile(log, "one\ntwo\nthree\n");
  const first = await startupLogs(root, 100, 2);
  assert.deepEqual(first.files[0].lines, ["one", "two"]);
  const second = await startupLogs(root, 100, 2, first.nextCursor!);
  assert.deepEqual(second.files[0].lines, ["three"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second, await startupLogs(root, 100, 2, first.nextCursor!));
  await assert.rejects(
    startupLogs(root, 100, 1, first.nextCursor!),
    /Logs or query changed/,
  );
  await writeFile(log, "replacement\n");
  await assert.rejects(
    startupLogs(root, 100, 2, first.nextCursor!),
    /Logs or query changed/,
  );
  await assert.rejects(startupLogs(root, 100, 0), /limit/);
  await assert.rejects(startupLogs(root, 100, 2, "bad"), /Invalid log cursor/);
});

test("idle scheduling does not reread archived transcripts", async (t) => {
  const { storage, service, makeRun } = await fixture(t);
  await makeRun(randomUUID());
  let reads = 0;
  const original = storage.read.bind(storage);
  storage.read = async (...args) => {
    reads++;
    return original(...args);
  };
  await service["compaction"]["reconcileCompactions"]();
  await service["runs"]["activatePending"]();
  assert.equal(reads, 0);
});

test("pending work index survives reload and clears after cancellation", async (t) => {
  const { storage, home, makeRun } = await fixture(t);
  const run = await makeRun(randomUUID());
  run.pendingInputs.push({
    message: { messageID: randomUUID(), content: "next", attachments: [] },
    source: null,
    cancelled: false,
  });
  await storage.write(run);
  assert.ok(storage.pendingRunIDs.has(run.runID));
  await storage.close();
  const reopened = new Storage(home);
  await reopened.initialize();
  try {
    assert.ok(reopened.pendingRunIDs.has(run.runID));
  } finally {
    await reopened.close();
  }
  run.pendingInputs[0].cancelled = true;
  await storage.write(run);
  assert.equal(storage.pendingRunIDs.has(run.runID), false);
});

test("a stalled read releases the serialization queue without accepting late results", async (t) => {
  const { boundedRead } = await import("../dist/storage/files.js");
  const { storage } = await fixture(t);
  let finish: any,
    committed = false;
  const stalled = storage.exclusive(async () => {
    await boundedRead(
      () =>
        new Promise<any>((resolve) => {
          finish = resolve;
        }),
      20,
    );
    committed = true;
  });
  const next = storage.exclusive(async () => "queue recovered");
  await assert.rejects(stalled, (e: any) => e.code === "storage.readTimeout");
  assert.equal(await next, "queue recovered");
  finish("late");
  await new Promise<any>((resolve) => setImmediate(resolve));
  assert.equal(committed, false);
  await storage.close();
});

test(
  "run read boundary times out an unresolved filesystem read",
  { timeout: 15000 },
  async (t) => {
    const { storage } = await fixture(t);
    storage["transcripts"]["readRun"] = () => new Promise<any>(() => {});
    await assert.rejects(
      storage.exclusive(() => storage.read(randomUUID())),
      (e: any) => e.code === "storage.readTimeout",
    );
    assert.equal(await storage.exclusive(async () => true), true);
  },
);

test("durable replacement and exclusive claims preserve distinct semantics", async (t) => {
  const { atomicJSON, claimJSON } = await import("../dist/storage/files.js");
  const root = await mkdtemp(path.join(tmpdir(), "nc-durable-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json");
  await claimJSON(file, { claimed: true }, 100);
  await assert.rejects(claimJSON(file, { claimed: false }, 100), {
    code: "EEXIST",
  });
  assert.deepEqual(JSON.parse((await readFile(file, "utf8")).toString()), {
    claimed: true,
  });
  await atomicJSON(file, { revision: 2 }, 100);
  await assert.rejects(
    atomicJSON(file, { large: "x".repeat(200) }, 100),
    /resource_limit/,
  );
  assert.deepEqual(JSON.parse((await readFile(file, "utf8")).toString()), {
    revision: 2,
  });
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});
test("updating one run leaves other message ownership indexed and rejects collisions before writing", async (t) => {
  const { storage, makeRun } = await fixture(t);
  const a = await makeRun("index-a"),
    b = await makeRun("index-b");
  a.revision++;
  a.messages.push({ ...a.messages[0], messageID: randomUUID() });
  await storage.write(a);
  assert.equal(storage.messages.get(b.messages[0].messageID)!.runID, b.runID);
  const bad = structuredClone(a);
  bad.messages[0].messageID = b.messages[0].messageID;
  await assert.rejects(storage.write(bad), /Duplicate message UUID/);
  assert.equal(
    (await storage.read(a.runID)).messages[0].messageID,
    a.messages[0].messageID,
  );
  assert.equal(
    storage.messages.get(a.messages.at(-1)!.messageID)!.runID,
    a.runID,
  );
});
test("pagination shares one frozen snapshot across replayed cursors", async (t) => {
  const { service } = await fixture(t);
  const items = Array.from({ length: 8 }, (_, i) => ({
    id: i,
    payload: "x".repeat(1024 * 1024),
  }));
  let calls = 0;
  const first = await service.page("large", { limit: 1 }, () => {
    calls++;
    return items;
  });
  const cursor = first.nextCursor;
  assert.ok(cursor);
  const second = await service.page<(typeof items)[number]>(
    "large",
    { limit: 1, cursor },
    () => {
      throw Error("Should not rebuild snapshot");
    },
  );
  items[1].id = 99;
  for (let i = 0; i < 20; i++) {
    const page: typeof first = await service.page<(typeof items)[number]>(
      "large",
      { limit: 1, cursor },
      () => [],
    );
    assert.equal(page.items[0].id, 1);
  }
  assert.equal(calls, 1);
  assert.equal(second.items[0].id, 1);
});

test("config and transcript writes share ordering and survive a rejected transaction", async (t) => {
  const { storage, home, makeRun } = await fixture(t);
  const run = await makeRun(randomUUID());
  const next = structuredClone(storage.store);
  next.config.revision++;
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const order: string[] = [];
  const configWrite = storage.exclusive(async () => {
    order.push("config:start");
    entered();
    await gate;
    await storage.saveConfig(next);
    order.push("config:committed");
  });
  await started;
  const rejected = assert.rejects(
    storage.exclusive(async () => {
      const invalid = structuredClone(storage.store);
      invalid.config.revision = -1;
      await storage.saveConfig(invalid);
    }),
  );
  const runWrite = storage.exclusive(async () => {
    assert.equal(storage.store.config.revision, next.config.revision);
    order.push("run:start");
    run.revision++;
    await storage.write(run);
    order.push("run:committed");
  });
  try {
    assert.deepEqual(order, ["config:start"]);
    assert.equal((await storage.read(run.runID)).revision, 1);
  } finally {
    release();
  }
  await Promise.all([configWrite, rejected, runWrite]);
  assert.deepEqual(order, [
    "config:start",
    "config:committed",
    "run:start",
    "run:committed",
  ]);
  assert.equal(
    JSON.parse(await readFile(path.join(home, "config.json"), "utf8")).config
      .revision,
    next.config.revision,
  );
  assert.equal((await storage.read(run.runID)).revision, 2);
  assert.equal(storage.summaries.get(run.runID)?.revision, 2);
});

test("transcript projection resolves pending inputs and attempts without changing event order", async (t) => {
  const { service, makeRun } = await fixture(t);
  const run = await makeRun(randomUUID());
  const pending = {
    messageID: randomUUID(),
    content: "pending",
    attachments: [],
  };
  run.pendingInputs.push({ message: pending, cancelled: false, source: null });
  const attempt = {
    attemptID: randomUUID(),
    turnID: run.turnID,
    startedAt: run.createdAt,
    updatedAt: run.updatedAt,
    status: "interrupted" as const,
    reason: "restart",
    thinking: true,
    text: "partial",
    reasoningContent: "thinking",
    toolCalls: [],
    truncated: false,
    messageID: null,
  };
  run.attempts.push(attempt);
  run.events = [
    { type: "pendingInput", data: { messageID: pending.messageID } },
    { type: "attempt", data: { attemptID: attempt.attemptID } },
    { type: "message", data: { messageID: randomUUID() } },
    { type: "started", data: {} },
    { type: "pendingInput", data: { messageID: pending.messageID } },
  ].map((event, index) => ({
    eventID: randomUUID(),
    sequence: index + 1,
    at: run.createdAt,
    turnID: run.turnID,
    ...event,
  })) as typeof run.events;
  const before = structuredClone(run);
  const projected = service.transcript(run);
  assert.deepEqual(
    projected.map((e) => e.sequence),
    [1, 2, 3, 4, 5],
  );
  assert.deepEqual(projected[0]!.message, {
    ...pending,
    role: "user",
    toolCalls: [],
    toolCallID: null,
  });
  assert.equal(projected[1]!.attempt, attempt);
  assert.equal(projected[1]!.message, null);
  assert.equal(projected[2]!.message, null);
  assert.equal(projected[2]!.attempt, null);
  assert.equal(projected[3]!.message, null);
  assert.deepEqual(projected[4]!.message, projected[0]!.message);
  assert.deepEqual(run, before);
});

test("canonical fingerprints retain persisted hash encoding and ignore object key order", async () => {
  const { canonical, fingerprint } = await import("../dist/utils/json.js");
  const { createHash } = await import("node:crypto");
  const expected = '{"a":[{"c":null,"d":true},2],"z":"é"}';
  const value = { z: "é", a: [{ d: true, c: null }, 2] };
  assert.equal(canonical(value), expected);
  assert.equal(
    fingerprint(value),
    createHash("sha256").update(expected).digest("hex"),
  );
  assert.equal(
    fingerprint(value),
    fingerprint({ a: [{ c: null, d: true }, 2], z: "é" }),
  );
  assert.notEqual(
    fingerprint(value),
    fingerprint({ ...value, a: [2, { c: null, d: true }] }),
  );
});

test("holding a queued run has consistent stored and indexed state and releases safely", async (t) => {
  const { service, makeRun } = await fixture(t);
  const run = await makeRun("queued-hold", "queued");
  await service.pauseRun(run.runID, run.revision, false);
  const held = await service.run(run.runID);
  assert.equal(held.state, "paused");
  assert.equal(held.held, true);
  assert.equal((await service.listRuns(undefined, "paused")).length, 1);
  assert.equal((await service.listRuns(undefined, "queued")).length, 0);
  await service.queueControl(run.runID, "release", held.revision, false);
  const released = await service.run(run.runID);
  assert.equal(released.held, false);
  assert.equal(released.pauseReason, "scheduler");
});

test("status aggregation preserves per-agent counts, ordering, empty agents and issue truncation", async (t) => {
  const { service, storage, makeRun } = await fixture(t);
  const { summarize, publicSummary } =
    await import("../dist/storage/transcript.js");
  const { terminal } = await import("../dist/schemas/common.js");
  const { triggerSchema } = await import("../dist/schemas/agent.js");
  const base = await makeRun("base");
  await makeRun("queued", "queued");
  storage.store.agents = [
    base.agent,
    { ...base.agent, agentID: "second" },
    { ...base.agent, agentID: "empty" },
  ];
  // Keep these intentional index fixtures stable; reconciliation is tested separately.
  storage.reconcile = async () => {};
  for (let i = 0; i < 121; i++) {
    const run = {
      ...base,
      runID: `issue-${String(i).padStart(3, "0")}`,
      state: "failed" as const,
      activeMs: i + 1,
      agent: { ...base.agent, agentID: i % 2 ? "second" : "reviewer" },
    };
    storage.summaries.set(run.runID, summarize(run));
  }
  const at = base.createdAt;
  storage.store.triggers = ["z", "a"].map((triggerID) =>
    triggerSchema.parse({
      triggerID,
      name: triggerID,
      agentID: "reviewer",
      enabled: false,
      schedule: { type: "manual" },
      revision: 1,
      createdAt: at,
      updatedAt: at,
      anchorAt: at,
    }),
  );
  const runs = [...storage.summaries.values()].sort(
    (a, b) =>
      b.updatedAt.localeCompare(a.updatedAt) || a.runID.localeCompare(b.runID),
  );
  const result = await manage(service, { command: "status" });
  assert.deepEqual(result.totals, {
    runs: runs.length,
    needsAttention: 121,
    activeMs: runs.reduce((sum, r) => sum + r.activeMs, 0),
  });
  for (const agent of result.agents) {
    const own = runs.filter((r) => r.agentID === agent.agentID);
    assert.equal(
      agent.activeRuns,
      own.filter((r) => !terminal(r.state)).length,
    );
    assert.equal(
      agent.needsAttention,
      own.filter((r) => r.outcome.needsAttention).length,
    );
    assert.equal(
      agent.activeMs,
      own.reduce((sum, r) => sum + r.activeMs, 0),
    );
    assert.deepEqual(agent.latestRun, own[0] ? publicSummary(own[0]) : null);
  }
  assert.deepEqual(
    result.agents[0].triggers.map((t: any) => t.triggerID),
    ["a", "z"],
  );
  assert.deepEqual(result.agents[1].triggers, []);
  assert.deepEqual(
    result.issues,
    runs
      .filter((r) => r.outcome.needsAttention)
      .slice(0, 100)
      .map(publicSummary),
  );
  assert.equal(result.issuesTruncated, true);
});
