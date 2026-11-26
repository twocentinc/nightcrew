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
import {
  RunDocuments,
  runDocumentSchema,
  projectDocument,
} from "./runDocument.js";
import { atomicJSON, syncDirectory } from "./files.js";
import { storeSchema, validateConfig } from "../schemas/config.js";
import { collectionEvents } from "./runEvents.js";
import { fingerprint } from "../utils/json.js";

/** Historical agent snapshots are upgraded only during explicit offline migration. */
function upgradeAgents(value: any, instantSlots: Set<string>): any {
  if (Array.isArray(value))
    return value.map((v) => upgradeAgents(v, instantSlots));
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, v]) => [
      key,
      upgradeAgents(v, instantSlots),
    ]),
  );
  if (
    typeof result.agentID === "string" &&
    typeof result.systemPrompt === "string" &&
    typeof result.slotID === "string"
  ) {
    result.executionClass = instantSlots.has(result.slotID)
      ? "instant"
      : "background";
    delete result.slotID;
  }
  return result;
}
export function convertStore(input: any) {
  if (input.version === 3) {
    const store = storeSchema.parse(input);
    validateConfig(store);
    return store;
  }
  if (input.version !== 2) throw Error("Expected configuration format 2 or 3");
  const old = structuredClone(input),
    slots = old.config.slots ?? [];
  const instantSlots = new Set<string>(
    slots.filter((s: any) => s.instant).map((s: any) => s.slotID),
  );
  old.agents = upgradeAgents(old.agents, instantSlots);
  old.config.scheduler ??= {};
  old.config.scheduler.instantModelID ??=
    slots.find((s: any) => s.instant)?.modelID ?? null;
  for (const model of old.config.models)
    model.contextTokens =
      slots.find((s: any) => s.modelID === model.modelID)?.contextTokens ??
      old.config.scheduler.contextTokens ??
      4096;
  delete old.config.slots;
  delete old.config.scheduler.contextTokens;
  old.version = 3;
  const store = storeSchema.parse(old);
  validateConfig(store);
  return store;
}

/** Explicit offline migration only. The normal reader never accepts legacy files. */
export function convertLegacyRun(
  input: any,
  instantSlots = new Set(["instant"]),
): StoredRun {
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
  return runProjectionSchema.parse(upgradeAgents(old, instantSlots));
}

/** Preserve lifecycle identities while upgrading single-file documents. */
export function convertDocument(
  input: any,
  instantSlots = new Set(["instant"]),
): StoredRun {
  if (![4, 5, 6].includes(input?.version))
    throw Error("Expected run format 4, 5 or 6");
  const {
    inFlight: _inFlight,
    configurationID,
    ...document
  } = structuredClone(input);
  if (!Array.isArray(document.events)) throw Error("Missing run events");
  const latest = document.events.findLast(
    (e: any) => e.type === "configurationChanged",
  );
  if (
    !latest ||
    (input.version < 6 && latest.data.configurationID !== configurationID) ||
    fingerprint(latest.data.configuration) !== latest.data.configurationID
  )
    throw Error("Invalid active configuration snapshot");
  document.events = document.events.map((event: any, index: number) => {
    const flat = event.type === "lifecycleRecorded" ? event.data.event : event;
    const upgraded = upgradeAgents(flat, instantSlots);
    if (upgraded.type === "configurationChanged")
      upgraded.data.configurationID = fingerprint(upgraded.data.configuration);
    const collection = Object.values(collectionEvents).find(
      (definition) => definition.event === upgraded.type,
    );
    if (collection && "key" in upgraded.data) {
      if (upgraded.data.key !== String(upgraded.data.value[collection.key]))
        throw Error("Mismatched checkpoint identity");
      delete upgraded.data.key;
    }
    return { ...upgraded, sequence: index + 1 };
  });
  return projectDocument(runDocumentSchema.parse({ ...document, version: 7 }));
}

export async function migrateHome(home: string, apply = false) {
  const runs = path.join(home, "runs"),
    marker = path.join(home, "migration-v7.json");
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
      if ([3, 4, 5, 6].includes(state.version)) ids.push(e.name);
      else if (state.version !== 7)
        throw Error("Unsupported run format: " + e.name);
    }
    plan = {
      backup: path.join(
        home,
        "backups",
        "runs-v7-" + new Date().toISOString().replace(/[:.]/g, "-"),
      ),
      ids,
    };
  }
  const configFile = path.join(home, "config.json"),
    originalConfig = path.join(plan.backup, "config.json");
  const rawConfig = JSON.parse(
    await readFile(originalConfig, "utf8").catch(async (e) => {
      if (e.code !== "ENOENT") throw e;
      return readFile(configFile, "utf8");
    }),
  );
  const convertedConfig = convertStore(rawConfig);
  const instantSlots = new Set<string>(
    (rawConfig.config.slots ?? [])
      .filter((s: any) => s.instant)
      .map((s: any) => s.slotID),
  );
  if (!apply)
    return {
      runs: plan.ids.length,
      configurationChanged: rawConfig.version !== 3,
      backup: plan.backup,
    };
  const lock = await open(path.join(home, "daemon.lock"), "wx", 0o600);
  await lock.writeFile(String(process.pid));
  await lock.close();
  try {
    await mkdir(plan.backup, { recursive: true, mode: 0o700 });
    await atomicJSON(marker, plan, 1048576);
    await atomicJSON(originalConfig, rawConfig, 8 * 1024 * 1024);
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
      if (current?.version === 7) {
        await new RunDocuments(runs).read(id);
        migrated++;
        continue;
      }
      const source = current ? destination : backup;
      const legacy =
        current ??
        JSON.parse(await readFile(path.join(source, "state.json"), "utf8"));
      const record =
        legacy.version === 3
          ? convertLegacyRun(legacy, instantSlots)
          : convertDocument(legacy, instantSlots);
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
    await atomicJSON(configFile, convertedConfig, 8 * 1024 * 1024);
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
