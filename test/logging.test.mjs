import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { OperationalLog, loggingSchema } from "../dist/logging.js";
import { requestSchemas } from "../dist/operationInputs.js";
const fixture = async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-log-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return home;
};
test("logging filters levels, strips non-operational data and rate limits repetition", async (t) => {
  const home = await fixture(t);
  let settings = loggingSchema.parse({});
  const logger = new OperationalLog(home, () => settings);
  logger.emit("daemon.ready", { pid: 123 });
  logger.emit("slot.snapshotRestoreFailed", {
    slotID: "instant",
    reason: "invalid_cache",
    prompt: "secret prompt",
    token: "secret token",
    stack: "secret stack",
  });
  logger.emit("slot.snapshotRestoreFailed", {
    slotID: "instant",
    reason: "invalid_cache",
  });
  await logger.flush();
  let content = await readFile(path.join(home, "logs/daemon.jsonl"), "utf8");
  const entries = content.trim().split("\n").map(JSON.parse);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event, "slot.snapshotRestoreFailed");
  assert.doesNotMatch(content, /secret|daemon.ready/);
  settings = { ...settings, level: "debug" };
  logger.emit("runtime.ready", { pid: 123 });
  await logger.flush();
  content = await readFile(path.join(home, "logs/daemon.jsonl"), "utf8");
  assert.match(content, /runtime.ready/);
  settings = { ...settings, level: "off" };
  logger.emit("daemon.stopFailed");
  await logger.flush();
  assert.equal(
    await readFile(path.join(home, "logs/daemon.jsonl"), "utf8"),
    content,
  );
  assert.equal(
    (await stat(path.join(home, "logs/daemon.jsonl"))).mode & 0o777,
    0o600,
  );
});
test("rotation bounds all retained files and shrinking retention removes old rotations", async (t) => {
  const home = await fixture(t);
  let settings = loggingSchema.parse({
    level: "debug",
    maxBytes: 1024,
    files: 3,
  });
  const logger = new OperationalLog(home, () => settings);
  for (let i = 0; i < 60; i++) {
    logger.emit("runtime.modelSwitched", {
      modelID: "model-" + i,
      durationMs: i,
    });
    await logger.flush();
  }
  let names = await readdir(path.join(home, "logs"));
  assert.deepEqual(names.sort(), [
    "daemon.jsonl",
    "daemon.jsonl.1",
    "daemon.jsonl.2",
  ]);
  for (const name of names) {
    assert.ok((await stat(path.join(home, "logs", name))).size <= 1024);
    for (const line of (await readFile(path.join(home, "logs", name), "utf8"))
      .trim()
      .split("\n"))
      JSON.parse(line);
  }
  settings = { ...settings, files: 1 };
  logger.emit("daemon.ready", { pid: 42 });
  await logger.flush();
  names = await readdir(path.join(home, "logs"));
  assert.deepEqual(names, ["daemon.jsonl"]);
});
test("off logging creates no files; quiet overrides configured logging", async (t) => {
  const home = await fixture(t);
  for (const logger of [
    new OperationalLog(home, () => loggingSchema.parse({ level: "off" })),
    new OperationalLog(
      home,
      () => loggingSchema.parse({ level: "debug" }),
      true,
    ),
  ]) {
    logger.emit("daemon.stopFailed");
    await logger.flush();
  }
  assert.deepEqual(await readdir(home), []);
});
test("logger refuses symlink targets and emits only a sanitized failure", async (t) => {
  const home = await fixture(t);
  const target = path.join(home, "private-data");
  await writeFile(target, "untouched");
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path.join(home, "logs"), { mode: 0o700 });
  await symlink(target, path.join(home, "logs/daemon.jsonl"));
  const logger = new OperationalLog(home, () => loggingSchema.parse({}));
  logger.emit("daemon.stopFailed");
  await logger.flush();
  assert.equal(await readFile(target, "utf8"), "untouched");
});
test("unrelated config patches do not reset logging defaults", () => {
  const request = requestSchemas["config update"].parse({
    expectedRevision: 1,
    changes: { interactionCooldownMs: 10 },
  });
  assert.equal(Object.hasOwn(request.changes, "logging"), false);
  assert.throws(() => loggingSchema.parse({ level: "trace" }));
  assert.throws(() => loggingSchema.parse({ maxBytes: 1 }));
});
