import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  chmod,
  rm,
  mkdir,
  writeFile,
  appendFile,
  rename,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { parseCLI, tailCommand } from "../dist/cli.js";
import { help } from "../dist/commands/registry.js";
import { Execution } from "../dist/engine/execution.js";
import { tailLogs } from "../dist/server/startup.js";
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const now = new Date().toISOString();

test("compact help, detailed command help, observation flags and removed aliases", () => {
  assert.equal(help().definitions, undefined);
  assert.equal(help("agents run").definitions!.length, 1);
  for (const args of [
    ["capabilities"],
    ["skills", "reload"],
    ["version", "--verbose"],
    ["version", "-v"],
    ["version", "--non-interactive"],
    ["runs", "get", "r", "--wait"],
    ["agents", "run", "a", "--wait", "--dry-run"],
    ["runs", "transcript", "r", "--tail", "--cursor", "x"],
  ])
    assert.throws(() => parseCLI(args));
  assert.equal(parseCLI(["config", "reload"]).command, "config reload");
  assert.equal(parseCLI(["agents", "run", "a", "--wait"]).timeoutMs, 7200000);
  assert.equal(parseCLI(["daemon", "logs", "--tail"]).timeoutMs, Infinity);
});

async function fake(t: import("node:test").TestContext, respond?: any) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-observe-"));
  const commands: any[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      const input = JSON.parse(buffer.split("\n")[0]);
      commands.push(input);
      socket.end(JSON.stringify({ ok: true, result: respond(input) }) + "\n");
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(path.join(home, "control.sock"), resolve),
  );
  await chmod(path.join(home, "control.sock"), 0o600);
  t.after(async () => {
    await new Promise<any>((resolve) => server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });
  return { home, commands };
}
function launch(home: string, args: string[], request?: any) {
  const child = spawn(
    process.execPath,
    [cli, ...args, "--home", home, ...(request ? ["--request", "-"] : [])],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (x) => (stdout += x));
  child.stderr.on("data", (x) => (stderr += x));
  child.stdin.end(request ? JSON.stringify(request) : "");
  return {
    child,
    done: new Promise<any>((resolve) =>
      child.on("close", (code) =>
        resolve({
          code,
          stderr,
          events: stdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((text: string) => JSON.parse(text)),
        }),
      ),
    ),
  };
}
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
};
for (const mode of ["complete", "timeout", "interrupt", "failed"])
  test("instant wait " + mode + " never cancels accepted work", async (t) => {
    let polls = 0;
    const requestID = randomUUID();
    const f = await fake(t, (input?: any) =>
      input.command === "instant submit"
        ? { requestID, status: "queued", eventsURL: "/unused", replayed: false }
        : {
            requestID,
            conversationID: request.conversationID,
            state:
              mode === "failed"
                ? "failed"
                : mode === "complete" && ++polls > 1
                  ? "completed"
                  : "running",
            createdAt: now,
            updatedAt: now,
            messages: [],
            result: null,
            error: null,
          },
    );
    const p = launch(
      f.home,
      [
        "instant",
        "submit",
        "--wait",
        "--timeout",
        mode === "timeout" ? "250ms" : "5s",
      ],
      request,
    );
    if (mode === "interrupt") {
      for (
        let i = 0;
        i < 100 && !f.commands.some((c) => c.command === "instant get");
        i++
      )
        await delay(10);
      p.child.kill("SIGINT");
    }
    const result = await p.done;
    assert.equal(result.events.length, 1, JSON.stringify(result));
    if (mode === "complete") {
      assert.equal(result.code, 0);
      assert.equal(result.events[0].result.state, "completed");
    } else {
      assert.notEqual(result.code, 0);
      assert.equal(result.events[0].error.details.acceptedID, requestID);
      assert.equal(result.events[0].error.details.cancelled, false);
    }
    assert.equal(
      f.commands.filter((c) => c.command === "instant submit").length,
      1,
    );
    assert.ok(
      f.commands.every((c) =>
        ["instant submit", "instant get"].includes(c.command),
      ),
    );
  });

test("transcript tail starts recent and continues after its last sequence without replay", async (t) => {
  const event = (sequence?: any) => ({
    sequence,
    at: now,
    type: "started",
    segment: 0,
    data: null,
    message: null,
    attempt: null,
  });
  const f = await fake(t, (input?: any) => ({
    items: input.request.recent
      ? [event(8), event(9)]
      : input.request.afterSequence === 9
        ? [event(10)]
        : [],
    nextCursor: null,
  }));
  const p = launch(f.home, [
    "runs",
    "transcript",
    "r",
    "--tail",
    "--timeout",
    "1200ms",
  ]);
  const result = await p.done;
  assert.deepEqual(
    result.events
      .filter((e?: any) => e.ok)
      .flatMap((e?: any) => e.result.items.map((x?: any) => x.sequence)),
    [8, 9, 10],
  );
  assert.equal(f.commands[0].request.recent, true);
  assert.ok(f.commands.slice(1).every((c) => c.request.afterSequence >= 9));
});

test("log tail handles duplicate lines, partial UTF-8, rotation and truncation", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nc-logtail-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "logs"));
  const file = path.join(home, "logs", "daemon.jsonl");
  await writeFile(file, "old\nrecent\n");
  await new Execution(5000).run(async () => {
    const iterator = tailLogs(home, 1);
    assert.deepEqual((await iterator.next()).value!.files[0].lines, ["recent"]);
    const pending = iterator.next();
    const unicode = Buffer.from("é\n");
    await appendFile(
      file,
      Buffer.concat([Buffer.from("same\nsame\n"), unicode.subarray(0, 1)]),
    );
    assert.deepEqual((await pending).value!.files[0].lines, ["same", "same"]);
    await appendFile(file, unicode.subarray(1));
    assert.deepEqual((await iterator.next()).value!.files[0].lines, ["é"]);
    await rename(file, file + ".1");
    await writeFile(file, "rotated\n");
    assert.deepEqual((await iterator.next()).value!.files[0].lines, [
      "rotated",
    ]);
    await writeFile(file, "new\n");
    assert.deepEqual((await iterator.next()).value!.files[0].lines, ["new"]);
    await iterator.return();
  });
});

test("transcript tail waits for its consumer before reading another batch", async (t) => {
  const f = await fake(t, (input?: any) => ({
    items: [
      {
        sequence: input.request.afterSequence ? 2 : 1,
        at: now,
        type: "started",
        segment: 0,
        data: null,
        message: null,
        attempt: null,
      },
    ],
    nextCursor: null,
  }));
  const execution = new Execution(5000);
  let release: any, entered: any;
  const ready = new Promise<any>((resolve) => (entered = resolve));
  const gate = new Promise<any>((resolve) => (release = resolve));
  const task = execution.run(() =>
    tailCommand(
      {
        home: f.home,
        resourceID: "r",
        request: { limit: 1 },
        values: {},
        dryRun: false,
        yes: false,
      },
      "runs transcript",
      async () => {
        entered();
        await gate;
        throw Error("finished test");
      },
    ),
  );
  const rejected = assert.rejects(task, /finished test/);
  await ready;
  await delay(100);
  assert.equal(f.commands.length, 1);
  release();
  await rejected;
});
