import { createHash, randomUUID } from "node:crypto";
import {
  cp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { runProjectionSchema, type StoredRun } from "../schemas/run.js";
import { RunDocuments } from "./runDocument.js";
import { atomicJSON, syncDirectory } from "./files.js";
import { fingerprint } from "../utils/json.js";

/** Explicit offline migration only. The normal reader never accepts legacy files. */
export function convertLegacyRun(input: any): StoredRun {
  if (input.version !== 3) throw Error("Expected run format 3");
  const old = structuredClone(input);
  const turns = new Map<number, string>();
  const users = new Map<string, any>(
    old.messages
      .filter((m: any) => m.role === "user")
      .map((m: any) => [m.messageID, m]),
  );
  for (const e of old.events) {
    const messageID = e.data?.messageID;
    if (
      users.has(messageID) &&
      (!turns.has(e.segment) || (old.evaluation && e.segment === 0))
    )
      turns.set(e.segment, messageID);
  }
  if (!turns.has(old.segment) && users.size)
    turns.set(old.segment, [...users.keys()].at(-1)!);
  const turn = (segment: number) => {
    const found = turns.get(segment);
    if (found) return found;
    // Preserve an explicit migration marker when old history lacks the originating input.
    const hash = createHash("sha256")
      .update(old.runID + ":" + segment)
      .digest("hex");
    const id = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    old.messages.unshift({
      messageID: id,
      role: "user",
      content:
        "[Migrated turn: original input identity was unavailable in the legacy record.]",
      attachments: [],
      toolCalls: [],
      toolCallID: null,
    });
    turns.set(segment, id);
    return id;
  };
  const current = turn(old.segment);
  for (const list of [
    old.events,
    old.attempts ?? [],
    old.validations ?? [],
    old.capabilityRefreshes ?? [],
  ])
    for (const item of list) {
      item.turnID = turn(item.segment);
      delete item.segment;
      if (item.type === "retried") {
        item.data.previousTurnID = turn(item.data.previousSegment);
        delete item.data.previousSegment;
      }
    }
  for (const key of ["recovery", "contextUsage"])
    if (old[key]) {
      old[key].turnID = turn(old[key].segment);
      delete old[key].segment;
    }
  old.turnID = current;
  delete old.segment;
  old.version = 4;
  const append = (type: string, data: any) =>
    old.events.push({
      eventID: randomUUID(),
      sequence: old.events.length + 1,
      at: old.updatedAt,
      turnID: current,
      type,
      data,
    });
  // Legacy accepted output is evidence, not a new model generation or delivery.
  if (old.execution.state === "completed" && old.result !== null) {
    let final = old.messages.find(
      (m: any) =>
        m.role === "assistant" &&
        !m.toolCalls.length &&
        m.content === old.result,
    );
    if (!final) {
      final = {
        messageID: randomUUID(),
        role: "assistant",
        content: old.result,
        attachments: [],
        toolCalls: [],
        toolCallID: null,
      };
      old.messages.push(final);
      append("message", { messageID: final.messageID });
    }
    const completed = [...old.events]
      .reverse()
      .find((e) => e.type === "completed" && e.turnID === current);
    if (completed) completed.data = { messageID: final.messageID };
    else append("completed", { messageID: final.messageID });
  }
  // Legacy tool calls had no durable start marker. Never guess they were not executed.
  if (
    !["completed", "failed", "cancelled", "timedOut"].includes(
      old.execution.state,
    )
  ) {
    const answered = new Set(
      old.messages
        .filter((m: any) => m.role === "tool")
        .map((m: any) => m.toolCallID),
    );
    for (const m of old.messages)
      for (const call of m.toolCalls ?? [])
        if (call.name !== "finish" && !answered.has(call.callID))
          append("toolStarted", { callID: call.callID, name: call.name });
  }
  return runProjectionSchema.parse(old);
}

export async function migrateHome(home: string, apply = false) {
  const runs = path.join(home, "runs"),
    marker = path.join(home, "migration-v4.json");
  let plan: { backup: string; ids: string[] };
  try {
    plan = JSON.parse(await readFile(marker, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const ids = [];
    for (const e of await readdir(runs, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const state = JSON.parse(
        await readFile(path.join(runs, e.name, "state.json"), "utf8"),
      );
      if (state.version === 3) ids.push(e.name);
      else if (state.version !== 4)
        throw Error("Unsupported run format: " + e.name);
    }
    plan = {
      backup: path.join(
        home,
        "backups",
        "runs-v4-" + new Date().toISOString().replace(/[:.]/g, "-"),
      ),
      ids,
    };
  }
  if (!apply) return { runs: plan.ids.length, backup: plan.backup };
  const lock = await open(path.join(home, "daemon.lock"), "wx", 0o600);
  await lock.writeFile(String(process.pid));
  await lock.close();
  try {
    await mkdir(plan.backup, { recursive: true, mode: 0o700 });
    await atomicJSON(marker, plan, 1048576);
    const preparedRoot = path.join(plan.backup, "prepared");
    await mkdir(preparedRoot, { mode: 0o700, recursive: true });
    const originals = path.join(plan.backup, "originals");
    await mkdir(originals, { mode: 0o700, recursive: true });
    let migrated = 0;
    for (const id of plan.ids) {
      const destination = path.join(runs, id),
        backup = path.join(originals, id),
        prepared = path.join(preparedRoot, id);
      let current: any;
      try {
        current = JSON.parse(
          await readFile(path.join(destination, "state.json"), "utf8"),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (current?.version === 4) {
        await new RunDocuments(runs).read(id);
        migrated++;
        continue;
      }
      const source = current ? destination : backup;
      const legacy =
        current ??
        JSON.parse(await readFile(path.join(source, "state.json"), "utf8"));
      const record = convertLegacyRun(legacy);
      await rm(prepared, { recursive: true, force: true });
      await mkdir(prepared, { recursive: true, mode: 0o700 });
      const documents = new RunDocuments(preparedRoot);
      await documents.write(record, true);
      const restored = await documents.read(id);
      if (fingerprint(restored) !== fingerprint(record))
        throw Error("Migration projection mismatch: " + id);
      for (const name of await readdir(source))
        if (name !== "state.json")
          await cp(path.join(source, name), path.join(prepared, name), {
            recursive: true,
            errorOnExist: true,
            force: false,
          });
      if (current) {
        await rename(destination, backup);
        await syncDirectory(runs);
        await syncDirectory(originals);
      }
      await rename(prepared, destination);
      await syncDirectory(runs);
      migrated++;
    }
    await atomicJSON(
      path.join(plan.backup, "migration.json"),
      { ...plan, migrated, completedAt: new Date().toISOString() },
      1048576,
    );
    await rm(marker);
    await syncDirectory(home);
    return { migrated, backup: plan.backup };
  } finally {
    await rm(path.join(home, "daemon.lock"));
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      home: { type: "string" },
      apply: { type: "boolean", default: false },
    },
  });
  if (!values.home || !path.isAbsolute(values.home))
    throw Error("--home must be absolute");
  console.log(JSON.stringify(await migrateHome(values.home, values.apply)));
}
