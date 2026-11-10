import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { control, parseCLI } from "../dist/cli.js";
import { executeExternalTool, toolDefinitionSchema } from "../dist/registry.js";
import { renderPlist } from "../dist/startup.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function call(home, args, request, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        cli,
        ...args,
        "--home",
        home,
        ...(request === undefined ? [] : ["--request", "-"]),
      ],
      { env, stdio: ["pipe", "pipe", "pipe"] },
    );
    let out = "",
      err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ code, ...JSON.parse(out) });
      } catch {
        reject(Error(out + err));
      }
    });
    child.stdin.end(request === undefined ? "" : JSON.stringify(request));
  });
}
test("CLI discovery, validation and complete offline resource CRUD", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.throws(
    () => parseCLI(["startup", "stop", "--bogus"]),
    /Unknown option/,
  );
  assert.throws(() => parseCLI(["help", "--timeout", "20"]), /requires/);
  assert.equal((await call(home, ["init"])).ok, true);
  assert.equal((await call(home, ["init"])).ok, false);
  const weights = path.join(home, "model.gguf");
  await writeFile(weights, "fixture");
  const model = {
    modelID: "qwen",
    kind: "chat",
    weightsPath: weights,
    projectorPath: null,
    idleUnloadMs: 300000,
  };
  const slot = {
    slotID: "instant",
    modelID: "qwen",
    index: 0,
    contextTokens: 1024,
    instant: true,
  };
  assert.equal(
    (await call(home, ["models", "create"], { model, slots: [slot] })).ok,
    true,
  );
  assert.equal(
    (await call(home, ["models", "get", "qwen"])).result.item.modelID,
    "qwen",
  );
  const external = {
    toolID: "inspect",
    description: "read-only fixture",
    adapter: "exec",
    executablePath: process.execPath,
    arguments: ["-e", "process.stdout.write(JSON.stringify({ok:true}))"],
    parameters: { type: "object", additionalProperties: false },
    readOnly: true,
    timeoutMs: 1000,
  };
  assert.equal(
    (await call(home, ["tools", "create"], { tool: external })).ok,
    true,
  );
  const skill = {
    skillID: "review",
    name: "review",
    description: "read-only",
    instructions: "Use inspect.",
    toolIDs: ["inspect"],
  };
  assert.equal((await call(home, ["skills", "create"], { skill })).ok, true);
  const agent = {
    agentID: "reviewer",
    name: "reviewer",
    systemPrompt: "Review.",
    mode: "agent-loop",
    modelID: "qwen",
    slotID: "instant",
    skillIDs: ["review"],
    toolIDs: ["inspect"],
    enabled: true,
  };
  assert.equal((await call(home, ["agents", "create"], { agent })).ok, true);
  assert.equal(
    (
      await call(home, ["agents", "disable", "reviewer"], {
        expectedRevision: 1,
      })
    ).result.agent.enabled,
    false,
  );
  const oldTool = (await call(home, ["tools", "get", "inspect"])).result.item;
  assert.equal(
    (
      await call(home, ["tools", "delete", "inspect", "--yes"], {
        expectedHash: oldTool.hash,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await call(home, ["tools", "update", "inspect"], {
        expectedHash: oldTool.hash,
        tool: { ...external, description: "updated" },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await call(home, ["tools", "update", "inspect"], {
        expectedHash: oldTool.hash,
        tool: external,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await call(home, ["models", "delete", "qwen", "--yes"], {
        expectedRevision: 2,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await call(home, ["agents", "delete", "reviewer"], {
        expectedRevision: 2,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await call(home, ["agents", "delete", "reviewer", "--yes"], {
        expectedRevision: 2,
      })
    ).ok,
    true,
  );
  const oldSkill = (await call(home, ["skills", "get", "review"])).result.item;
  assert.equal(
    (
      await call(home, ["skills", "delete", "review", "--yes"], {
        expectedHash: oldSkill.hash,
      })
    ).ok,
    true,
  );
  const newTool = (await call(home, ["tools", "get", "inspect"])).result.item;
  assert.equal(
    (
      await call(home, ["tools", "delete", "inspect", "--yes"], {
        expectedHash: newTool.hash,
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await call(home, ["models", "delete", "qwen", "--yes"], {
        expectedRevision: 2,
      })
    ).ok,
    true,
  );
  assert.equal((await call(home, ["models", "list"])).result.items.length, 0);
  const config = (await call(home, ["config", "get"])).result.config;
  assert.equal(config.rootTokenHash, undefined);
  const preview = await call(home, ["config", "update", "--dry-run"], {
    expectedRevision: config.revision,
    changes: { interactionCooldownMs: 100 },
  });
  assert.equal(preview.result.changed, false);
  assert.equal(
    (await call(home, ["config", "get"])).result.config.interactionCooldownMs,
    300000,
  );
  const schema = await call(home, ["schema", "get", "tools.create"]);
  assert.ok(schema.result.schema.properties.tool);
});
test("external tools validate input, isolate environment, bound timeout and return JSON", async () => {
  const tool = toolDefinitionSchema.parse({
    toolID: "read",
    description: "fixture",
    adapter: "exec",
    executablePath: process.execPath,
    arguments: [
      "-e",
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({secret:process.env.PASSWORD??null,ok:true})));',
    ],
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
    readOnly: true,
    timeoutMs: 1000,
  });
  await assert.rejects(
    executeExternalTool(tool, {}, new AbortController().signal),
  );
  assert.deepEqual(
    await executeExternalTool(
      tool,
      { query: "hello" },
      new AbortController().signal,
    ),
    { secret: null, ok: true },
  );
  await assert.rejects(
    executeExternalTool(
      {
        ...tool,
        arguments: ["-e", "setTimeout(()=>{},10000)"],
        timeoutMs: 100,
      },
      { query: "hello" },
      new AbortController().signal,
    ),
    /timed out/,
  );
});
test("foreground daemon serves local CRUD and shuts down cleanly", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-daemon-"));
  let child;
  t.after(async () => {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(home, { recursive: true, force: true });
  });
  const binary = path.join(home, "llama-server");
  await writeFile(
    binary,
    '#!/bin/sh\nprintf "%s\\n" "--models-preset --parallel --slots --kv-unified-per-slot"\n',
  );
  await chmod(binary, 0o700);
  const env = {
    ...process.env,
    PATH: home + path.delimiter + process.env.PATH,
  };
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  assert.equal((await call(home, ["init"], { port }, env)).ok, true);
  child = spawn(process.execPath, [cli, "daemon", "run", "--home", home], {
    env,
    stdio: "ignore",
  });
  const exit = new Promise((resolve) => child.once("exit", resolve));
  let status;
  for (let i = 0; i < 100; i++) {
    try {
      status = await control(home, { command: "daemon status" }, 1000);
      break;
    } catch {}
    await delay(50);
  }
  assert.equal(status.pid, child.pid);
  const presence = await call(home, ["presence", "status"], undefined, env);
  assert.equal(presence.ok, true);
  assert.deepEqual(Object.keys(presence.result).sort(), [
    "cooldownUntil",
    "presence",
  ]);
  assert.ok(["present", "away"].includes(presence.result.presence.state));
  assert.equal(typeof presence.result.presence.samplingHealthy, "boolean");
  assert.equal(presence.result.cooldownUntil, status.cooldownUntil);
  const listed = await call(
    home,
    [
      "runs",
      "list",
      "--agent",
      "missing",
      "--state",
      "completed",
      "--limit",
      "1",
    ],
    undefined,
    env,
  );
  assert.equal(listed.ok, true);
  assert.deepEqual(listed.result, { items: [], nextCursor: null });
  const searched = await call(
    home,
    ["runs", "search", "hello world", "--limit", "1"],
    undefined,
    env,
  );
  assert.equal(searched.ok, true);
  assert.deepEqual(searched.result, { items: [], nextCursor: null });
  assert.equal(
    (await call(home, ["runs", "list", "--state", "bogus"], undefined, env)).ok,
    false,
  );
  assert.equal(
    (await call(home, ["runs", "list", "--limit", "0"], undefined, env)).ok,
    false,
  );
  assert.equal(
    (await call(home, ["runs", "list", "--limit", "1"], { limit: 2 }, env)).ok,
    false,
  );

  assert.equal(
    (
      await call(
        home,
        ["config", "update"],
        { expectedRevision: 1, changes: { interactionCooldownMs: 1000 } },
        env,
      )
    ).ok,
    true,
  );
  assert.equal(
    (await call(home, ["config", "get"], undefined, env)).result.config
      .interactionCooldownMs,
    1000,
  );
  const stat = await import("node:fs/promises").then((fs) =>
    fs.stat(path.join(home, "control.sock")),
  );
  assert.equal(stat.mode & 0o777, 0o600);
  await control(home, { command: "daemon stop" });
  assert.equal(await exit, 0);
  await assert.rejects(readFile(path.join(home, "daemon.lock")));
  const plist = renderPlist(home);
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /daemon/);
  assert.doesNotMatch(plist, /rootTokenHash|Bearer/);
});

test("presence sampling needs no home and status never silently falls back offline", async (t) => {
  const parent = await mkdtemp(path.join(tmpdir(), "nc-presence-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, "absent");
  const offline = await call(home, ["presence", "status"]);
  assert.equal(offline.ok, false);
  const sample = await call(home, ["presence", "sample"]);
  assert.equal(sample.ok, true);
  assert.ok(["present", "away"].includes(sample.result.state));
  assert.equal(typeof sample.result.samplingHealthy, "boolean");
  assert.ok(Number.isFinite(Date.parse(sample.result.observedAt)));
  if (!sample.result.samplingHealthy) {
    assert.equal(sample.result.state, "present");
    assert.equal(sample.result.reason, "samplingFailure");
    assert.equal(typeof sample.result.diagnostic, "string");
  }
  const { stat } = await import("node:fs/promises");
  await assert.rejects(stat(home), { code: "ENOENT" });
  assert.throws(
    () => parseCLI(["presence", "sample", "--dry-run"]),
    /not supported/,
  );
});
