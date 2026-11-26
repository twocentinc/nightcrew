import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { runProjectionSchema, decodeRun } from "../dist/schemas/run.js";
import {
  RunDocuments,
  projectDocument,
  recordDocument,
} from "../dist/storage/runDocument.js";
import { convertLegacyRun, migrateHome } from "../dist/storage/migrate.js";
import { Storage } from "../dist/storage/store.js";
import { RunRecords } from "../dist/storage/records.js";
import { ToolExecution } from "../dist/engine/execution/tools.js";
import { initializeHome } from "../dist/storage/config.js";
import { settings } from "./fixtures.ts";
const at = "2026-11-25T00:00:00.000Z";
function sample() {
  const turnID = randomUUID(),
    answerID = randomUUID();
  return runProjectionSchema.parse({
    version: 4,
    runID: randomUUID(),
    revision: 1,
    createdAt: at,
    updatedAt: at,
    turnID,
    execution: { state: "completed" },
    activeMs: 0,
    agent: {
      agentID: "worker",
      name: "worker",
      revision: 1,
      systemPrompt: "Test",
      mode: "agent-loop",
      modelID: "q",
      executionClass: "background",
      skillIDs: [],
      toolIDs: [],
      timeoutMs: 30000,
      enabled: true,
      createdAt: at,
      updatedAt: at,
    },
    skills: [],
    messages: [
      {
        messageID: turnID,
        role: "user",
        content: "hello",
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      },
      {
        messageID: answerID,
        role: "assistant",
        content: "accepted",
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      },
    ],
    events: [
      {
        eventID: randomUUID(),
        sequence: 1,
        at,
        turnID,
        type: "message",
        data: { messageID: turnID },
      },
      {
        eventID: randomUUID(),
        sequence: 2,
        at,
        turnID,
        type: "completed",
        data: { messageID: answerID },
      },
    ],
    result: "accepted",
    hookReceipts: [],
  });
}
async function fixture(t: import("node:test").TestContext) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-document-"));
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
          idleUnloadMs: 0,
        },
      ],

      hooks: [],
    }),
  );
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
}
test("single state document derives output and isolates queued messages", () => {
  const record = sample();
  const pending = {
    messageID: randomUUID(),
    content: "later",
    attachments: [],
  };
  record.pendingInputs.push({
    message: pending,
    source: null,
    cancelled: false,
  });
  const document = recordDocument(record);
  assert.equal("result" in document, false);
  assert.equal("attempts" in document, false);
  assert.equal("pendingInputs" in document, false);
  assert.equal(document.messages.length, 3);
  const projected = projectDocument(document);
  assert.deepEqual(projected, record);
  assert.equal(projected.messages.length, 2);
  const failed = { ...document, execution: { state: "failed" as const } };
  assert.equal(projectDocument(failed).result, null);
});
test("offline migration keeps originals and preserves the projected run without replay", async (t) => {
  const home = await fixture(t);
  const record = sample();
  const legacy: any = structuredClone(record);
  legacy.version = 3;
  legacy.segment = 0;
  delete legacy.turnID;
  for (const event of legacy.events) {
    event.segment = 0;
    delete event.turnID;
  }
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(home, "runs", record.runID), {
    mode: 0o700,
    recursive: true,
  });
  const bytes = JSON.stringify(legacy);
  await writeFile(path.join(home, "runs", record.runID, "state.json"), bytes, {
    mode: 0o600,
  });
  assert.deepEqual(convertLegacyRun(legacy), record);
  const result = await migrateHome(home, true);
  assert.equal((result as any).migrated, 1);
  assert.equal(
    await readFile(
      path.join(result.backup, "originals", record.runID, "state.json"),
      "utf8",
    ),
    bytes,
  );
  assert.deepEqual(
    await new RunDocuments(path.join(home, "runs")).read(record.runID),
    record,
  );
  assert.deepEqual(await readdir(path.join(home, "runs", record.runID)), [
    "state.json",
  ]);
  assert.equal((await migrateHome(home)).runs, 0);
});
for (const committed of [false, true])
  test(`killed tool process ${committed ? "with" : "without"} committed result is never invoked twice`, async (t) => {
    const home = await fixture(t),
      record = sample();
    record.execution = { state: "running" };
    record.result = null;
    record.messages[1] = {
      ...record.messages[1],
      content: "",
      toolCalls: [{ callID: "external", name: "external", arguments: "{}" }],
    };
    record.events[1] = {
      ...record.events[1],
      type: "message",
      data: { messageID: record.messages[1]!.messageID },
    };
    const store = new Storage(home);
    await store.initialize();
    await store.write(decodeRun(record), true);
    await store.close();
    const base = new URL("../dist/", import.meta.url).href;
    const script = path.join(home, "child.js");
    await writeFile(
      script,
      `
    import {Storage} from ${JSON.stringify(base + "storage/store.js")};
    import {RunRecords} from ${JSON.stringify(base + "storage/records.js")};
    import {ToolExecution} from ${JSON.stringify(base + "engine/execution/tools.js")};
    import {appendFile,writeFile} from 'node:fs/promises';
    setInterval(()=>{},1000);
    const home=${JSON.stringify(home)},storage=new Storage(home);await storage.initialize();
    const records=new RunRecords({storage}),run=await storage.read(${JSON.stringify(record.runID)});
    const tools=new ToolExecution({storage,records,registry:{},context:{atStorageLimit:()=>false}});
    tools.invokeTool=async()=>{await appendFile(home+'/calls','call\\n');
      ${committed ? "return {ok:true};" : "await writeFile(home+'/ready','');await new Promise(()=>{});"}
    };
    await tools.resumeTools(run,run.messages,run.messages.at(-1),false,new AbortController());
    await writeFile(home+'/ready','');setInterval(()=>{},1000);
  `,
    );
    const child = spawn(process.execPath, [script], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (x) => (stderr += x));
    t.after(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    });
    let ready = false;
    for (let i = 0; i < 500; i++) {
      ready = await readFile(path.join(home, "ready")).then(
        () => true,
        () => false,
      );
      if (ready) break;
      if (child.exitCode !== null)
        throw Error(stderr || "Child exited before checkpoint");
      await delay(10);
    }
    assert.ok(ready, stderr);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
    const restarted = new Storage(home);
    await restarted.initialize();
    const records = new RunRecords({ storage: restarted });
    await records.recoverInterrupted();
    const run = await restarted.read(record.runID);
    const tools = new ToolExecution({
      storage: restarted,
      records,
      registry: {} as any,
      context: { atStorageLimit: () => false } as any,
    });
    tools.invokeTool = async () => {
      throw Error("Must not repeat external call");
    };
    await tools.resumeTools(
      run,
      run.messages,
      run.messages.find((m) => m.role === "assistant"),
      false,
      new AbortController(),
    );
    assert.equal(await readFile(path.join(home, "calls"), "utf8"), "call\n");
    if (committed)
      assert.equal(run.messages.filter((m) => m.role === "tool").length, 1);
    else {
      assert.equal(run.held, true);
      assert.equal(run.error?.code, "tool_outcome_unknown");
    }
    await restarted.close();
  });

test("killed delivery remains unknown and is not dispatched again", async (t) => {
  const home = await fixture(t),
    record = sample();
  const hook = path.join(home, "deliver.js");
  await writeFile(
    hook,
    `#!${process.execPath}\nimport {appendFile,writeFile} from 'node:fs/promises';await appendFile(${JSON.stringify(home + "/deliveries")},'sent\\n');await writeFile(${JSON.stringify(home + "/ready")},'');setInterval(()=>{},1000);`,
    { mode: 0o700 },
  );
  const definition = {
    hookID: "delivery",
    purpose: "delivery" as const,
    event: "run.completed" as const,
    executablePath: hook,
    timeoutMs: 60000,
  };
  const storage = new Storage(home);
  await storage.initialize();
  await storage.write(decodeRun(record), true);
  await storage.close();
  const base = new URL("../dist/", import.meta.url).href;
  const script = path.join(home, "child.js");
  await writeFile(
    script,
    `
    import {Storage} from ${JSON.stringify(base + "storage/store.js")};
    import {RunRecords} from ${JSON.stringify(base + "storage/records.js")};
    import {Hooks} from ${JSON.stringify(base + "engine/hooks.js")};
    const storage=new Storage(${JSON.stringify(home)});await storage.initialize();storage.store.config.hooks=[${JSON.stringify(definition)}];
    const records=new RunRecords({storage});const hooks=new Hooks({storage,records,dispatch:{hasActivity:()=>false},runner:{liveRun:()=>undefined}});
    hooks.scheduleHooks(await storage.read(${JSON.stringify(record.runID)}));await hooks.drain();
  `,
  );
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (x) => (stderr += x));
  t.after(() => child.kill("SIGKILL"));
  let ready = false;
  for (let i = 0; i < 500; i++) {
    ready = await readFile(path.join(home, "ready")).then(
      () => true,
      () => false,
    );
    if (ready) break;
    if (child.exitCode !== null)
      throw Error(stderr || "Child exited before delivery");
    await delay(10);
  }
  assert.ok(ready, stderr);
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
  const restarted = new Storage(home);
  await restarted.initialize();
  try {
    restarted.store.config.hooks = [definition];
    const records = new RunRecords({ storage: restarted });
    await records.recoverInterrupted();
    const run = await restarted.read(record.runID);
    assert.equal(run.hookReceipts[0]!.status, "unknown");
    const { Hooks } = await import("../dist/engine/hooks.js");
    const hooks = new Hooks({
      storage: restarted,
      records,
      dispatch: { hasActivity: () => false },
      runner: { liveRun: () => undefined },
    });
    hooks.scheduleHooks(run);
    await hooks.drain();
    assert.equal(
      await readFile(path.join(home, "deliveries"), "utf8"),
      "sent\n",
    );
  } finally {
    await restarted.close();
  }
});

test("flat lifecycle events preserve public cursors across saves and format-4 migration", async (t) => {
  const home = await fixture(t),
    record = sample();
  const document = recordDocument(record);
  assert.equal(document.version, 7);
  assert.equal("inFlight" in document, false);
  const { isLifecycleEvent } = await import("../dist/storage/runEvents.js");
  assert.deepEqual(
    document.events.filter(isLifecycleEvent).map((e) => e.eventID),
    record.events.map((e) => e.eventID),
  );
  assert.deepEqual(recordDocument(record, document), document);
  const legacy = {
    ...document,
    version: 4,
    configurationID: document.events.find(
      (e) => e.type === "configurationChanged",
    )!.data.configurationID,
    inFlight: { generationID: randomUUID() },
    events: document.events.map((event) =>
      isLifecycleEvent(event)
        ? {
            ...event,
            eventID: randomUUID(),
            type: "lifecycleRecorded",
            data: {
              event: record.events.find((e) => e.eventID === event.eventID),
            },
          }
        : event,
    ),
  };
  const { convertDocument } = await import("../dist/storage/migrate.js");
  assert.deepEqual(convertDocument(legacy), record);
  const { mkdir } = await import("node:fs/promises");
  const directory = path.join(home, "runs", record.runID);
  await mkdir(directory, { mode: 0o700, recursive: true });
  const bytes = JSON.stringify(legacy);
  await writeFile(path.join(directory, "state.json"), bytes, { mode: 0o600 });
  const migration = await migrateHome(home, true);
  assert.equal(
    await readFile(
      path.join(migration.backup, "originals", record.runID, "state.json"),
      "utf8",
    ),
    bytes,
  );
  const documents = new RunDocuments(path.join(home, "runs"));
  assert.deepEqual(await documents.read(record.runID), record);
  record.events.push({
    eventID: randomUUID(),
    sequence: record.events.length + 1,
    turnID: record.turnID,
    at,
    type: "held",
    data: {},
  });
  record.revision++;
  await documents.write(record);
  assert.deepEqual((await documents.read(record.runID)).events, record.events);
  assert.equal((await migrateHome(home)).runs, 0);
});

test("stored event payloads reject unknown types and malformed values", async () => {
  const { runDocumentSchema } = await import("../dist/storage/runDocument.js");
  const document = recordDocument(sample());
  for (const event of [
    { type: "invented", data: {} },
    { type: "turnPriorityChanged", data: { value: "true" } },
    { type: "toolStarted", data: { callID: "call" } },
  ]) {
    assert.equal(
      runDocumentSchema.safeParse({
        ...document,
        events: [{ ...document.events[0], ...event }],
      }).success,
      false,
    );
  }
});

test("format-5 migration moves model capacities and agent priority without losing run evidence", async (t) => {
  const home = await fixture(t),
    record = sample();
  const { mkdir } = await import("node:fs/promises");
  const { fingerprint } = await import("../dist/utils/json.js");
  const rawConfig = JSON.parse(
    await readFile(path.join(home, "config.json"), "utf8"),
  );
  rawConfig.version = 2;
  rawConfig.config.scheduler.contextTokens = 4096;
  rawConfig.config.slots = [
    {
      slotID: "human",
      modelID: "q",
      instant: true,
      index: 0,
      contextTokens: 8192,
    },
    {
      slotID: "worker",
      modelID: "q",
      instant: false,
      index: 1,
      contextTokens: 8192,
    },
  ];
  delete rawConfig.config.models[0].contextTokens;
  const agent = { ...record.agent, slotID: "human" } as any;
  delete agent.executionClass;
  rawConfig.agents = [agent];
  const document = recordDocument(record) as any;
  document.version = 5;
  for (const event of document.events)
    if (event.type === "configurationChanged") {
      event.data.configuration.agent = agent;
      event.data.configurationID = fingerprint(event.data.configuration);
      document.configurationID = event.data.configurationID;
    }
  const configBytes = JSON.stringify(rawConfig),
    runBytes = JSON.stringify(document);
  await writeFile(path.join(home, "config.json"), configBytes, { mode: 0o600 });
  await mkdir(path.join(home, "runs", record.runID), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(
    path.join(home, "runs", record.runID, "state.json"),
    runBytes,
    { mode: 0o600 },
  );
  const migrated = await migrateHome(home, true);
  const config = JSON.parse(
    await readFile(path.join(home, "config.json"), "utf8"),
  );
  assert.equal(config.version, 3);
  assert.equal(config.config.models[0].contextTokens, 8192);
  assert.equal("slots" in config.config, false);
  assert.equal("contextTokens" in config.config.scheduler, false);
  assert.equal(config.agents[0].executionClass, "instant");
  const docs = new RunDocuments(path.join(home, "runs"));
  const restored = await docs.read(record.runID);
  assert.deepEqual(restored, {
    ...record,
    agent: { ...record.agent, executionClass: "instant" },
  });
  assert.equal("configurationID" in (await docs.document(record.runID)), false);
  assert.equal(
    await readFile(path.join(migrated.backup, "config.json"), "utf8"),
    configBytes,
  );
  assert.equal(
    await readFile(
      path.join(migrated.backup, "originals", record.runID, "state.json"),
      "utf8",
    ),
    runBytes,
  );
});

test("format-6 collection keys migrate to record identities and cannot be written again", async (t) => {
  const home = await fixture(t), record = sample();
  record.capabilityRefreshes.push({
    at, turnID: record.turnID, sourceAgentRevision: 1,
    previousToolIDs: [], previousSkillIDs: [], previousTools: [], previousSkills: [],
  });
  const document = recordDocument(record);
  const checkpoint = document.events.find((e) => e.type === "capabilitiesRefreshed")!;
  assert.equal("key" in checkpoint.data, false);
  assert.deepEqual(projectDocument(document), record);
  assert.deepEqual(recordDocument(record, document), document);
  const legacy: any = structuredClone(document);
  legacy.version = 6;
  const event = legacy.events.find((e: any) => e.type === "capabilitiesRefreshed");
  event.data.key = at;
  const { convertDocument } = await import("../dist/storage/migrate.js");
  const { runDocumentSchema } = await import("../dist/storage/runDocument.js");
  assert.deepEqual(convertDocument(legacy), record);
  assert.equal(runDocumentSchema.safeParse({ ...legacy, version: 7 }).success, false);
  event.data.key = "wrong";
  assert.throws(() => convertDocument(legacy), /Mismatched checkpoint identity/);
  event.data.key = at;
  const { mkdir } = await import("node:fs/promises");
  const directory = path.join(home, "runs", record.runID);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "state.json"), JSON.stringify(legacy));
  await migrateHome(home, true);
  const documents = new RunDocuments(path.join(home, "runs"));
  assert.deepEqual(await documents.read(record.runID), record);
  const migrated = await documents.document(record.runID);
  assert.equal(migrated.version, 7);
  assert.ok(migrated.events.every((e) => !("key" in e.data)));
});
