import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { snapshots } from "../scripts/contracts.mjs";
import { commandDefinitions, help, exportSchemas } from "../dist/commands.js";
import { parseCLI } from "../dist/cli.js";
import { Execution, withoutExecution, checkpoint } from "../dist/execution.js";
import { Storage } from "../dist/storage.js";
const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const call = (args, { keepStdin = false } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, stdout, stderr, envelope: JSON.parse(stdout) });
      } catch (e) {
        reject(e);
      }
    });
    if (!keepStdin) child.stdin.end();
  });
test("versioned command catalog and schemas stay aligned with parser and help", async () => {
  await snapshots();
  const schemas = exportSchemas();
  for (const definition of commandDefinitions) {
    assert.ok(help("", true).commands.includes(definition.name));
    assert.ok(schemas[definition.name.replaceAll(" ", ".") + ".request"]);
    assert.ok(schemas[definition.name.replaceAll(" ", ".") + ".result"]);
    const parsed = parseCLI([
      ...definition.name.split(" "),
      ...(definition.operand === "required" ? ["fixture"] : []),
    ]);
    assert.equal(parsed.definition, definition);
  }
  assert.ok(help("models").commands.every((c) => c.startsWith("models ")));
  assert.equal(
    parseCLI(["models", "create", "--help"]).helpScope,
    "models create",
  );
  assert.throws(() => parseCLI(["version", "--yes"]), /not supported/);
  assert.throws(
    () => parseCLI(["version", "--quiet", "--verbosity", "verbose"]),
    /cannot be combined/,
  );
});
test("errors preserve correlation, classify retries and keep stdout machine readable", async () => {
  const invalid = await call(["unknown", "--request-id=supervisor-turn"]);
  assert.equal(invalid.code, 2);
  assert.equal(invalid.envelope.requestID, "supervisor-turn");
  assert.equal(invalid.envelope.error.retrySafety, "never");
  const denied = await call(["config", "token", "rotate"]);
  assert.equal(denied.code, 8);
  const verbose = await call(["version", "--verbosity", "verbose"]);
  assert.equal(verbose.stdout.trim().split("\n").length, 1);
  assert.equal(
    JSON.parse(verbose.stderr.trim().split("\n")[0]).event,
    "command.started",
  );
  assert.equal((await call(["version", "--quiet"])).stderr, "");
  const timeout = await call(["init", "--request", "-", "--timeout", "25ms"], {
    keepStdin: true,
  });
  assert.equal(timeout.code, 6);
  assert.equal(timeout.envelope.error.retrySafety, "unsafe");
  const dry = await call(
    ["init", "--dry-run", "--request", "-", "--timeout", "25ms"],
    { keepStdin: true },
  );
  assert.equal(dry.envelope.error.retrySafety, "safe");
});
test("expired queued writes cannot commit; detached work survives a request deadline", async () => {
  const storage = new Storage("/unused");
  let release;
  let wrote = false;
  const first = storage.exclusive(
    () => new Promise((resolve) => (release = resolve)),
  );
  const execution = new Execution(20, true);
  await assert.rejects(
    execution.run(() =>
      storage.exclusive(async () => {
        wrote = true;
      }),
    ),
    (e) => e.code === "runtime.timeout" && e.retrySafety === "unsafe",
  );
  release();
  await first;
  await delay(10);
  assert.equal(wrote, false);
  let background;
  await new Execution(20).run(async () => {
    background = withoutExecution(async () => {
      await delay(40);
      checkpoint();
      return "completed";
    });
  });
  assert.equal(await background, "completed");
});
test("diagnostics report missing configuration without creating a runtime home", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "nightcrew-diagnostics-"));
  try {
    const home = path.join(temp, "absent");
    const result = await call(["doctor", "--home", home]);
    assert.equal(result.envelope.ok, true);
    assert.equal(result.envelope.result.healthy, false);
    assert.equal(result.envelope.result.serviceReady, null);
    assert.ok(
      result.envelope.result.checks.some(
        (c) => c.id === "configuration" && c.status === "fail",
      ),
    );
    await assert.rejects(readFile(path.join(home, "config.json")), {
      code: "ENOENT",
    });
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test("eval CLI deadline accommodates suites while ordinary command limits remain bounded", async () => {
  const { parseCLI } = await import('../dist/cli.js');
  assert.equal(parseCLI(['evals','run']).timeoutMs, 7200000);
  assert.equal(parseCLI(['evals','run','--timeout','120m']).timeoutMs, 7200000);
  assert.equal(parseCLI(['agents','list']).timeoutMs, 90000);
  assert.throws(() => parseCLI(['agents','list','--timeout','6m']), /Timeout/);
  assert.throws(() => parseCLI(['evals','run','--timeout','121m']), /Timeout/);
});

test('simplified CLI removes obsolete names and hides advanced and internal operations', async () => {
  const {parseCLI}=await import('../dist/cli.js');
  const {help}=await import('../dist/commands.js');
  for(const args of [['startup','status'],['inference','submit'],['queue','list'],['fleet','status'],['presence','status'],['scheduler','get'],['scheduler','update'],['scheduler','status'],['agents','enable','a'],['triggers','disable','t'],['evals','sample']]) assert.throws(()=>parseCLI(args),/Unknown command/);
  assert.equal(parseCLI(['instant','submit']).command,'instant submit');
  assert.equal(parseCLI(['runs','pause','a']).command,'runs pause');
  assert.equal(help().commands.includes('runs hooks retry'),false);
  assert.equal(help('',true).commands.includes('runs hooks retry'),true);
  assert.equal(help('',true).commands.includes('evals sample'),false);
});

test('command names use words without hyphens and removed commands are rejected', async () => {
  const {help}=await import('../dist/commands.js');
  for(const name of help('',true).commands) assert.equal(name.includes('-'), false, name);
  for(const args of [['agents','cache','a'],['agents','reset-cache','a'],['runs','retry-hook','r'],['auth','rotate']]) assert.throws(()=>parseCLI(args), /Unknown command/);
});
