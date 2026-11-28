import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { control, parseCLI } from "../dist/cli.js";
import { toolDefinitionSchema } from "../dist/schemas/tool.js";
import { executeExternalTool } from "../dist/engine/capabilities/registry.js";
import { renderPlist } from "../dist/server/startup.js";
const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
async function call(
  home: string,
  args: string[],
  request?: any,
  env = process.env,
) {
  return new Promise<any>((resolve, reject) => {
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
    /unknown option/i,
  );
  assert.throws(() => parseCLI(["help", "--timeout", "20"]), /requires/);
  assert.equal((await call(home, ["init"])).ok, true);
  assert.equal((await call(home, ["init"])).ok, false);
  const weights = path.join(home, "model.gguf");
  await writeFile(weights, "fixture");
  const model = {
    modelID: "qwen",
    kind: "chat" as const,
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
    (
      await call(home, ["models", "create"], {
        model: { ...model, contextTokens: slot.contextTokens },
      })
    ).ok,
    true,
  );
  assert.equal(
    (await call(home, ["models", "get", "qwen"])).result.item.modelID,
    "qwen",
  );
  const external = {
    toolID: "inspect",
    description: "read-only fixture",
    executablePath: process.execPath,
    argv: ["-e", "process.stdout.write(JSON.stringify({ok:true}))"],
    parameters: { type: "object" as const, additionalProperties: false },
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
  const readSkill = await call(home, ["skills", "read"], {
    skillIDs: ["review"],
  });
  assert.equal(readSkill.ok, true);
  assert.equal(readSkill.result.skills[0].instructions, "Use inspect.");
  assert.equal((await call(home, ["schema", "get", "skills.read"])).ok, true);

  const modelDetails = await call(home, ["models", "get", "qwen"]);
  assert.equal(modelDetails.ok, true);
  assert.equal(modelDetails.result.capabilities.tools.adapterSupported, true);
  assert.equal(modelDetails.result.capabilities.tools.modelVerified, false);
  const agent = {
    agentID: "reviewer",
    name: "reviewer",
    systemPrompt: "Review.",
    mode: "agentLoop",
    modelID: "qwen",
    executionClass: "instant",
    skillIDs: ["review"],
    toolIDs: ["inspect"],
    enabled: true,
  };
  assert.equal((await call(home, ["agents", "create"], { agent })).ok, true);
  const inspected = await call(home, ["agents", "get", agent.agentID]);
  assert.equal(inspected.ok, true);
  assert.deepEqual(inspected.result.cache.items, []);
  assert.match(inspected.result.cache.contextID, /^agent-/);
  const trigger = {
    triggerID: "timer",
    name: "timer",
    agentID: "reviewer",
    enabled: true,
    schedule: { type: "interval" as const, everyMs: 900000 },
  };
  assert.equal(
    (await call(home, ["triggers", "create"], { trigger })).ok,
    true,
  );
  assert.equal(
    (await call(home, ["triggers", "get", "timer"])).result.item
      .automaticDispatchEnabled,
    true,
  );
  assert.equal((await call(home, ["triggers", "list"])).result.items.length, 1);
  const changedTrigger = await call(home, ["triggers", "update", "timer"], {
    expectedRevision: 1,
    changes: { name: "renamed" },
  });
  assert.equal(changedTrigger.result.item.enabled, true);
  assert.equal(changedTrigger.result.item.queuePolicy, "skip");
  assert.equal((await call(home, ["triggers", "fire", "timer"])).ok, false); // daemon required
  assert.equal(
    (
      await call(home, ["triggers", "delete", "timer", "--yes"], {
        expectedRevision: 2,
      })
    ).ok,
    true,
  );

  assert.equal(
    (
      await call(home, ["agents", "update", "reviewer"], {
        agentVersion: 1,
        changes: { enabled: false },
      })
    ).result.agent.enabled,
    false,
  );
  const oldTool = (await call(home, ["tools", "get", "inspect"])).result.item;
  assert.equal(
    (
      await call(home, ["tools", "delete", "inspect", "--yes"])
    ).ok,
    false,
  );
  assert.equal(
    (
      await call(home, ["tools", "update", "inspect"], {
        changes: { description: "updated" },
      })
    ).ok,
    true,
  );
  assert.equal(
    (
      await call(home, ["tools", "update", "inspect"], {
        expectedHash: oldTool.hash,
        changes: { description: external.description },
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
        agentVersion: 2,
      })
    ).ok,
    true,
  );
  const changedSkill = await call(home, ["skills", "update", "review"], {
    changes: { description: "Updated review instructions" },
  });
  assert.equal(changedSkill.result.item.description, "Updated review instructions");
  assert.equal((await call(home, ["skills", "delete", "review", "--yes"])).ok, true);
  assert.equal((await call(home, ["tools", "delete", "inspect", "--yes"])).ok, true);
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
    executablePath: process.execPath,
    argv: [
      "-e",
      'process.stdin.resume();process.stdin.on("end",()=>process.stdout.write(JSON.stringify({secret:process.env.PASSWORD??null,ok:true})));',
    ],
    parameters: {
      type: "object" as const,
      properties: { query: { type: "string" } },
      required: ["query"],
      additionalProperties: false,
    },
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
        argv: ["-e", "setTimeout(()=>{},10000)"],
        timeoutMs: 100,
      },
      { query: "hello" },
      new AbortController().signal,
    ),
    /timed out/,
  );
});
test("CLI-only daemon serves local CRUD without an HTTP listener and shuts down cleanly", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-daemon-"));
  let child: any;
  t.after(async () => {
    if (child?.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise<any>((resolve) => child.once("exit", resolve));
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
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as import("node:net").AddressInfo).port;
  await new Promise<any>((resolve) => probe.close(resolve));
  assert.equal(
    (await call(home, ["init"], { port, httpEnabled: false }, env)).ok,
    true,
  );
  child = spawn(process.execPath, [cli, "daemon", "run", "--home", home], {
    env,
    stdio: "ignore",
  });
  const exit = new Promise<any>((resolve) => child.once("exit", resolve));
  let status: any;
  for (let i = 0; i < 100; i++) {
    try {
      status = await control(home, { command: "status" }, 1000);
      break;
    } catch {}
    await delay(50);
  }
  assert.equal(status.pid, child.pid);
  const config = await call(home, ["config", "get"], undefined, env);
  assert.equal(config.result.config.httpEnabled, false);
  const updated = await call(
    home,
    ["config", "update"],
    {
      expectedRevision: config.result.config.revision,
      changes: { httpEnabled: true },
    },
    env,
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.result.restartRequired, true);
  // A config edit alone must not open the listener before restart.

  // Binding the configured port proves that CLI-only startup opened no TCP listener.
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<any>((resolve) => probe.close(resolve));
  const overview = await call(home, ["status", "--details"], undefined, env);
  assert.equal(overview.ok, true);
  assert.ok(overview.result.scheduler);
  assert.ok(
    ["present", "away"].includes(overview.result.runtime.presence.state),
  );
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
    ["runs", "list", "--query", "hello world", "--limit", "1"],
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
        {
          expectedRevision: updated.result.config.revision,
          changes: { interactionCooldownMs: 1000 },
        },
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

test("executable-only tools preserve structured JSON input and reject adapter fields", async () => {
  const definition = {
    toolID: "structured",
    description: "Echo typed JSON input",
    executablePath: process.execPath,
    argv: [
      "-e",
      'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.stringify(JSON.parse(s))));',
    ],
    parameters: {
      type: "object" as const,
      properties: {
        count: { type: "integer" as const },
        enabled: { type: "boolean" as const },
        tags: { type: "array" as const, items: { type: "string" } },
        filter: {
          type: "object" as const,
          properties: { nested: { type: "number" as const } },
          required: ["nested"],
          additionalProperties: false,
        },
      },
      required: ["count", "enabled", "tags", "filter"],
      additionalProperties: false,
    },
  };
  assert.equal(
    toolDefinitionSchema.safeParse({ ...definition, readOnly: true }).success,
    false,
  );
  assert.equal(
    toolDefinitionSchema.safeParse({ ...definition, arguments: [] }).success,
    false,
  );
  const tool = toolDefinitionSchema.parse(definition);
  const input = {
    count: 3,
    enabled: false,
    tags: ["a", "b"],
    filter: { nested: 1.5 },
  };
  assert.deepEqual(
    await executeExternalTool(tool, input, new AbortController().signal),
    input,
  );
  assert.equal(
    toolDefinitionSchema.safeParse({ ...definition, adapter: "exec" }).success,
    false,
  );
  assert.equal(
    toolDefinitionSchema.safeParse({ ...definition, argv: [123] }).success,
    false,
  );
  assert.equal(
    toolDefinitionSchema.safeParse({ ...definition, executablePath: undefined })
      .success,
    false,
  );
  for (const legacy of [{adapter: "exec"}, {readOnly: true}, {arguments: []}])
    assert.equal(toolDefinitionSchema.safeParse({...definition, ...legacy}).success, false);

});

test("tool JSON parameters reach Nightcrew CLI through --request -", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-tool-stdin-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await call(home, ["init"])).ok, true);
  const definition = toolDefinitionSchema.parse({
    toolID: "list_runs",
    description: "List saved runs",
    executablePath: process.execPath,
    argv: [cli, "runs", "list", "--home", home, "--request", "-"],
    parameters: {
      type: "object" as const,
      properties: {
        limit: { type: "integer" as const, minimum: 1, maximum: 100 },
      },
      required: ["limit"],
      additionalProperties: false,
    },
  });
  const response = await executeExternalTool(
    definition,
    { limit: 3 },
    new AbortController().signal,
  );
  assert.equal(response.ok, true);
  assert.equal(response.command, "runs list");
  assert.deepEqual(response.result.items, []);
  const viaArgv = await executeExternalTool(
    {
      ...definition,
      argv: [cli, "runs", "list", "--home", home, "--limit", "%limit%"],
    },
    { limit: 3 },
    new AbortController().signal,
  );
  assert.equal(viaArgv.ok, true);
  assert.equal(viaArgv.command, "runs list");
  assert.deepEqual(viaArgv.result.items, []);
});

test("argv placeholders preserve boundaries and typed stdin without shell evaluation", async () => {
  const tool = toolDefinitionSchema.parse({
    toolID: "argv_echo",
    description: "Echo argv and stdin",
    executablePath: process.execPath,
    argv: [
      "-e",
      'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>process.stdout.write(JSON.stringify({argv:process.argv.slice(1),input:JSON.parse(s)})));',
      "--",
      "%position%",
      "--limit=%limit%",
      "%enabled%",
      "%filter.owner%",
      "%items%",
      "%items.0%",
      "%nothing%",
      "%%position%%",
      "100%%",
      "%object%",
    ],
    parameters: {
      type: "object" as const,
      properties: {
        position: { type: "string" },
        limit: { type: "integer" as const, default: 7 },
        enabled: { type: "boolean" as const },
        filter: {
          type: "object" as const,
          properties: { owner: { type: "string" } },
          required: ["owner"],
        },
        items: { type: "array" as const, items: { type: "string" } },
        nothing: { type: "null" as const },
        object: { type: "object" as const },
      },
      required: ["position", "enabled", "filter", "items", "nothing", "object"],
      additionalProperties: false,
    },
  });
  const input = {
    position: 'a b "$(touch /nope)" ; %limit%',
    enabled: false,
    filter: { owner: "andi" },
    items: ["first", "two words"],
    nothing: null,
    object: { a: 2 },
  };
  const result = await executeExternalTool(
    tool,
    input,
    new AbortController().signal,
  );
  assert.deepEqual(result.argv, [
    input.position,
    "--limit=7",
    "false",
    "andi",
    '["first","two words"]',
    "first",
    "null",
    "%position%",
    "100%",
    '{"a":2}',
  ]);
  assert.deepEqual(result.input, { ...input, limit: 7 });
  const { resolveToolArgv } =
    await import("../dist/engine/capabilities/registry.js");
  assert.throws(
    () => resolveToolArgv(["%missing%"], {}),
    /Missing tool parameter/,
  );
  assert.throws(
    () => resolveToolArgv(["%constructor%"], {}),
    /Missing tool parameter/,
  );
  assert.throws(() => resolveToolArgv(["%x%"], { x: "a\0b" }), /NUL/);
  assert.throws(
    () => resolveToolArgv(["%x%"], { x: "x".repeat(4001) }),
    /4000/,
  );
  assert.deepEqual(resolveToolArgv(["%x%", "%x%/%x%", "50%"], { x: "" }), [
    "",
    "/",
    "50%",
  ]);
  await assert.rejects(
    executeExternalTool(
      { ...tool, argv: ["%missing%"] },
      input,
      new AbortController().signal,
    ),
    /Missing tool parameter/,
  );
});

test("tool schema edits invalidate cached argument validation", async () => {
  const tool = {
    toolID: "schema-cache",
    description: "test",
    executablePath: process.execPath,
    argv: ["-e", `process.stdin.pipe(process.stdout)`],
    timeoutMs: 5000,
    parameters: {
      type: "object" as const,
      properties: { value: { type: "string" } },
      required: ["value"],
      additionalProperties: false,
    },
  };
  const signal = new AbortController().signal;
  assert.deepEqual(
    await executeExternalTool(tool, { value: "first" }, signal),
    { value: "first" },
  );
  tool.parameters.properties.value.type = "number";
  await assert.rejects(executeExternalTool(tool, { value: "first" }, signal));
  assert.deepEqual(await executeExternalTool(tool, { value: 42 }, signal), {
    value: 42,
  });
});

test("declarative eval flags decode files, map UUIDs and reject duplicate request fields", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nc-cli-bindings-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  assert.equal((await call(home, ["init"])).ok, true);
  const file = path.join(home, "input.json"),
    output = path.join(home, "output.json");
  await writeFile(
    file,
    JSON.stringify({
      evalID: "flags",
      agentID: "worker",
      messages: [{ role: "user", content: "hello" }],
    }),
  );
  let result = await call(home, ["evals", "create", "--file", file]);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  await writeFile(file, JSON.stringify({ page: 2 }));
  await writeFile(output, JSON.stringify({ rows: [1, 2] }));
  result = await call(home, [
    "evals",
    "tools",
    "set",
    "flags",
    "--tool",
    "read",
    "--input",
    file,
    "--output",
    output,
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.result.item.definition.tools, [
    { toolID: "read", input: { page: 2 }, output: { rows: [1, 2] } },
  ]);
  assert.equal(
    (
      await call(
        home,
        [
          "evals",
          "tools",
          "set",
          "flags",
          "--tool",
          "read",
          "--output",
          output,
        ],
        { toolID: "duplicate" },
      )
    ).ok,
    false,
  );
  await writeFile(
    file,
    JSON.stringify({ role: "user", content: "replacement" }),
  );
  result = await call(home, [
    "evals",
    "transcript",
    "set",
    "flags",
    "--file",
    file,
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  const id = result.result.item.definition.messages[0].messageID;
  assert.equal(result.result.item.definition.messages.length, 1);
  await writeFile(file, JSON.stringify({ role: "user", content: "updated" }));
  result = await call(home, [
    "evals",
    "transcript",
    "update",
    "flags",
    "--message",
    id,
    "--file",
    file,
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.result.item.definition.messages[0].content, "updated");
  result = await call(home, [
    "evals",
    "transcript",
    "delete",
    "flags",
    "--message",
    id,
  ]);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.deepEqual(result.result.item.definition.messages, []);
});
