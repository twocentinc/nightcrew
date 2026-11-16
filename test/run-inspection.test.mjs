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
import { Storage, initializeHome } from "../dist/storage.js";
import { Service } from "../dist/service.js";
import { manage } from "../dist/management.js";
import { runSchema } from "../dist/contracts.js";
import { startupLogs } from "../dist/startup.js";

async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), "nc-inspect-"));
  const home = path.join(root, "home");
  await initializeHome(home, {
    host: "127.0.0.1",
    port: 6970,
    models: [],
    slots: [],
    hooks: [],
  });
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
  const makeRun = async (runID, state = "completed") => {
    const at = "2026-01-01T00:00:00.000Z";
    const messageID = randomUUID();
    const run = runSchema.parse({
      version: 2,
      runID,
      revision: 1,
      createdAt: at,
      updatedAt: at,
      agent: {
        agentID: "reviewer",
        name: "reviewer",
        revision: 1,
        systemPrompt: "Test",
        mode: "single-turn",
        modelID: "test",
        slotID: "background",
        skillIDs: [],
        toolIDs: [],
        timeoutMs: 1000,
        enabled: false,
        createdAt: at,
        updatedAt: at,
      },
      skills: [],
      toolSnapshots: [],
      segment: 0,
      state,
      pauseReason: null,
      activeMs: 0,
      messages: [
        {
          messageID,
          role: "user",
          content: "hello world",
          attachments: [
            {
              name: "note.txt",
              mediaType: "text/plain",
              dataBase64: Buffer.from("attachment needle").toString("base64"),
            },
          ],
          toolCalls: [],
          toolCallID: null,
        },
      ],
      events: [
        { sequence: 1, at, type: "message", segment: 0, data: { messageID } },
        {
          sequence: 2,
          at,
          type: state === "completed" ? "completed" : "queued",
          segment: 0,
          data: {},
        },
      ],
      result: state === "completed" ? "result needle" : null,
      error: null,
      hookReceipts: [],
    });
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
  const list = (request) => manage(service, { command: "runs list", request });
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
    command: "runs search",
    resourceID: "attachment needle",
    request: { state: "queued" },
  });
  assert.deepEqual(
    search.items.map((x) => x.runID),
    ["c"],
  );
  const result = await manage(service, {
    command: "runs search",
    resourceID: "result needle",
    request: { limit: 1 },
  });
  assert.equal(result.items[0].eventSequence, 2);
  assert.ok(result.nextCursor);
  await assert.rejects(
    manage(service, { command: "runs search", resourceID: "", request: {} }),
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
  const invalid = JSON.parse(before);
  invalid.events[0].data.messageID = randomUUID();
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
  const second = await startupLogs(root, 100, 2, first.nextCursor);
  assert.deepEqual(second.files[0].lines, ["three"]);
  assert.equal(second.nextCursor, null);
  assert.deepEqual(second, await startupLogs(root, 100, 2, first.nextCursor));
  await assert.rejects(
    startupLogs(root, 100, 1, first.nextCursor),
    /Logs or query changed/,
  );
  await writeFile(log, "replacement\n");
  await assert.rejects(
    startupLogs(root, 100, 2, first.nextCursor),
    /Logs or query changed/,
  );
  await assert.rejects(startupLogs(root, 100, 0), /limit/);
  await assert.rejects(startupLogs(root, 100, 2, "bad"), /Invalid log cursor/);
});

test('idle scheduling does not reread archived transcripts', async t => {
  const {storage,service,makeRun} = await fixture(t);
  await makeRun(randomUUID());
  let reads=0;
  const original=storage.read.bind(storage);
  storage.read=async (...args)=>{reads++;return original(...args)};
  await service.reconcileCompactions();
  await service.activatePending();
  assert.equal(reads,0);
});

test('pending work index survives reload and clears after cancellation', async t => {
  const {storage,home,makeRun}=await fixture(t);
  const run=await makeRun(randomUUID());
  run.pendingInputs.push({message:{messageID:randomUUID(),content:'next',attachments:[]},source:null});
  await storage.write(run);
  assert.ok(storage.pendingRunIDs.has(run.runID));
  await storage.close();
  const reopened=new Storage(home);await reopened.initialize();
  try {assert.ok(reopened.pendingRunIDs.has(run.runID));}
  finally {await reopened.close();}
  run.pendingInputs[0].cancelled=true;
  await storage.write(run);
  assert.equal(storage.pendingRunIDs.has(run.runID),false);
});

test('a stalled read releases the serialization queue without accepting late results', async t => {
  const {boundedRead}=await import('../dist/storage.js');
  const {storage}=await fixture(t);
  let finish,committed=false;
  const stalled=storage.exclusive(async()=>{
    await boundedRead(()=>new Promise(resolve=>{finish=resolve}),20);
    committed=true;
  });
  const next=storage.exclusive(async()=> 'queue recovered');
  await assert.rejects(stalled,e=>e.code==='storage.readTimeout');
  assert.equal(await next,'queue recovered');
  finish('late');await new Promise(resolve=>setImmediate(resolve));
  assert.equal(committed,false);
  await storage.close();
});

test('run read boundary times out an unresolved filesystem read', {timeout:15000}, async t => {
  const {storage}=await fixture(t);
  storage.readRun=()=>new Promise(()=>{});
  await assert.rejects(storage.exclusive(()=>storage.read(randomUUID())), e=>e.code==='storage.readTimeout');
  assert.equal(await storage.exclusive(async()=>true),true);
});
