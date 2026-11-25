import { runOutcome, type outcomeSchema } from "../engine/supervision.js";
import type { z } from "zod";
import { validateCompactionState } from "../engine/compaction.js";
import type { OperationalLog } from "../server/logging.js";
import { NightcrewError } from "../engine/protocol.js";
import { checkpoint } from "../engine/execution.js";
import { createHash, randomUUID, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  mkdir,
  open,
  lstat,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { type ZodType } from "zod";
import {
  runSchema,
  storeSchema,
  validateConfig,
  type Store,
  type Run,
  type Config,
} from "../engine/contracts.js";

export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");
export const canonical = (x: unknown): string => {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (x && typeof x === "object")
    return (
      "{" +
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(x);
};
export type Summary = Pick<
  Run,
  | "runID"
  | "revision"
  | "createdAt"
  | "updatedAt"
  | "state"
  | "segment"
  | "activeMs"
  | "pauseReason"
  | "held"
> & {
  agentID: string;
  remainingMs: number;
  outcome: z.infer<typeof outcomeSchema>;
};
export const summarize = (r: Run): Summary => ({
  outcome: runOutcome(r),
  runID: r.runID,
  agentID: r.agent.agentID,
  revision: r.revision,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  state: r.state,
  segment: r.segment,
  activeMs: r.activeMs,
  pauseReason: r.pauseReason,
  held: r.held,
  remainingMs: Math.max(0, r.agent.timeoutMs - r.activeMs),
});
// Only use this boundary for reads: a timed-out write must never release the
// serialization lock while it may still commit. Late read results are discarded.
export async function boundedRead<T>(read: () => Promise<T>, timeoutMs = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new NightcrewError(
          "storage.readTimeout", "State read exceeded its deadline", 6, "safe",
        )), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
async function regular(file: string, max: number) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max)
    throw new Error("Invalid state file");
  if (
    process.getuid &&
    (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)
  )
    throw new NightcrewError(
      "config.invalidPermissions",
      "State files must be owner-only",
      3,
    );
}
export async function readJSON<T>(
  file: string,
  schema: ZodType<T>,
  max: number,
): Promise<T> {
  return boundedRead(async () => {
    await regular(file, max);
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      return schema.parse(JSON.parse(await handle.readFile("utf8")));
    } finally {
      await handle.close();
    }
  });
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
export async function atomicJSON(file: string, value: unknown, max: number) {
  checkpoint();
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > max) throw Error("resource_limit");
  const directory = path.dirname(file),
    temporary = path.join(directory, "." + randomUUID() + ".tmp");
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    checkpoint();
    await rename(temporary, file);
    await syncDirectory(directory);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}
// Unlike replacement, an exclusive claim must never overwrite an existing file.
// A failed write leaves the claim present: its outcome is uncertain, not retryable.
export async function claimJSON(file: string, value: unknown, max: number) {
  checkpoint();
  const data = JSON.stringify(value);
  if (Buffer.byteLength(data) > max) throw Error("resource_limit");
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(path.dirname(file));
}
export class Storage {
  store!: Store;
  summaries = new Map<string, Summary>();
  messages = new Map<string, { runID: string; index: number }>();
  private messageIDsByRun = new Map<string, Set<string>>();
  unreadable: string[] = [];
  readonly pendingRunIDs = new Set<string>();
  readonly compactingRunIDs = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private ownsLock = false;
  constructor(
    readonly home: string,
    private logger?: OperationalLog,
  ) {
    if (!path.isAbsolute(home))
      throw new Error("Runtime home must be absolute");
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const checked = () => {
      checkpoint();
      return fn();
    };
    const operation = this.tail.then(checked, checked);
    this.tail = operation.catch((error) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code && ["ENOSPC", "EIO", "EROFS", "EACCES", "EPERM"].includes(code))
        this.logger?.emit("storage.writeFailed", {
          reason:
            code === "ENOSPC" ? "space" : code === "EIO" ? "io" : "permissions",
        });
    });
    return operation;
  }
  async initialize(): Promise<void> {
    checkpoint();
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    const st = await lstat(this.home);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0)
      throw new NightcrewError(
        "config.invalidHome",
        "Runtime home must be an owner-only directory",
        3,
      );
    if (process.getuid && st.uid !== process.getuid())
      throw new NightcrewError(
        "config.invalidHome",
        "Runtime home owner mismatch",
        3,
      );
    const lock = path.join(this.home, "daemon.lock");
    try {
      const h = await open(lock, "wx", 0o600);
      await h.writeFile(String(process.pid));
      await h.close();
      this.ownsLock = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      await regular(lock, 100);
      const pid = Number(await readFile(lock, "utf8"));
      if (!Number.isInteger(pid) || pid <= 0)
        throw new NightcrewError(
          "config.invalidLock",
          "Invalid daemon lock",
          3,
        );
      try {
        process.kill(pid, 0);
        throw new NightcrewError(
          "daemon.homeInUse",
          "Runtime home already in use",
          9,
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await unlink(lock);
      return this.initialize();
    }
    try {
      this.store = await readJSON(
        path.join(this.home, "config.json"),
        storeSchema,
        8 * 1024 * 1024,
      );
      validateConfig(this.store);
      await mkdir(path.join(this.home, "runs"), { mode: 0o700 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") {
        await this.close();
        throw e;
      }
    }
    try {
      const dir = await lstat(path.join(this.home, "runs"));
      if (
        !dir.isDirectory() ||
        dir.isSymbolicLink() ||
        (dir.mode & 0o077) !== 0
      )
        throw new Error("Invalid runs directory");
      for (const entry of await readdir(path.join(this.home, "runs"), {
        withFileTypes: true,
      })) {
        if (entry.name.startsWith(".")) continue;
        if (
          !entry.isDirectory() ||
          !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(entry.name)
        ) {
          this.unreadable.push(entry.name);
          continue;
        }
        try {
          this.index(await this.read(entry.name));
        } catch {
          this.unreadable.push(entry.name);
        }
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }
  private checkedMessageIDs(r: Run) {
    const indexedMessages = [
      ...r.messages,
      ...r.pendingInputs.map((p) => ({ ...p.message, role: "user" })),
    ];
    const nextIDs = new Set<string>();
    indexedMessages.forEach((m) => {
      if (m.role !== "user") return;
      const existing = this.messages.get(m.messageID);
      if (nextIDs.has(m.messageID) || (existing && existing.runID !== r.runID))
        throw Error("Duplicate message UUID");
      nextIDs.add(m.messageID);
    });
    return nextIDs;
  }
  private index(r: Run) {
    const indexedMessages = [
      ...r.messages,
      ...r.pendingInputs.map((p) => ({ ...p.message, role: "user" })),
    ];
    const nextIDs = this.checkedMessageIDs(r);
    for (const messageID of this.messageIDsByRun.get(r.runID) ?? [])
      this.messages.delete(messageID);
    this.messageIDsByRun.set(r.runID, nextIDs);
    this.summaries.set(r.runID, summarize(r));
    if (r.pendingInputs.some((p) => !p.cancelled))
      this.pendingRunIDs.add(r.runID);
    else this.pendingRunIDs.delete(r.runID);
    if (r.compaction?.status === "waiting" && r.compaction.childRunID)
      this.compactingRunIDs.add(r.runID);
    else this.compactingRunIDs.delete(r.runID);
    indexedMessages.forEach((m, index) => {
      if (m.role === "user")
        this.messages.set(m.messageID, { runID: r.runID, index });
    });
  }
  async reconcile() {
    const entries = await boundedRead(() => readdir(path.join(this.home, "runs"), {
      withFileTypes: true,
    })).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (!this.summaries.has(e.name) && !this.unreadable.includes(e.name)) {
        try {
          this.index(await this.read(e.name));
        } catch (error) {
          if (error instanceof NightcrewError && error.code === "storage.readTimeout") throw error;
          this.unreadable.push(e.name);
        }
      }
    }
  }
  async read(runID: string) {
    try { return await boundedRead(() => this.readRun(runID)); }
    catch (error) {
      if (error instanceof NightcrewError && error.code === "storage.readTimeout")
        this.logger?.emit("storage.readTimeout", {reason:"io"});
      throw error;
    }
  }
  private async readRun(runID: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runID))
      throw new Error("Invalid run ID");
    const dir = path.join(this.home, "runs", runID);
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Invalid run directory");
    const r = await readJSON(
      path.join(dir, "state.json"),
      runSchema,
      64 * 1024 * 1024,
    );
    if (r.runID !== runID) throw new Error("Run identity mismatch");
    if (
      new Set([
        ...r.messages.map((x) => x.messageID),
        ...r.pendingInputs.map((p) => p.message.messageID),
      ]).size !==
      r.messages.length + r.pendingInputs.length
    )
      throw new Error("Duplicate transcript message");
    if (r.events.some((x, i) => x.sequence !== i + 1))
      throw new Error("Invalid event order");
    const calls = new Set<string>();
    const results = new Set<string>();
    validateCompactionState(r);
    for (const m of r.messages) {
      if (m.role !== "user" && m.attachments.length)
        throw new Error("Invalid attachments");
      if (m.toolCalls.length && m.role !== "assistant")
        throw new Error("Invalid tool calls");
      for (const c of m.toolCalls) {
        if (calls.has(c.callID)) throw new Error("Duplicate tool call");
        calls.add(c.callID);
      }
      if (m.role === "tool") {
        if (
          !m.toolCallID ||
          !calls.has(m.toolCallID) ||
          results.has(m.toolCallID)
        )
          throw new Error("Invalid tool result");
        results.add(m.toolCallID);
      } else if (m.toolCallID) throw new Error("Invalid tool result reference");
    }
    for (const source of [
      r.triggerSource,
      ...r.triggerHistory,
      ...r.pendingInputs.map((p) => p.source),
    ].filter((x): x is NonNullable<typeof x> => !!x)) {
      if (
        source.definition.agentID !== r.agent.agentID ||
        new Set(source.occurrences.map((o) => o.occurrenceID)).size !==
          source.occurrences.length
      )
        throw new Error("Invalid trigger provenance");
      for (const occurrence of source.occurrences) {
        const message = [
          ...r.messages,
          ...r.pendingInputs.map((p) => ({
            ...p.message,
            role: "user" as const,
            toolCalls: [],
            toolCallID: null,
          })),
        ].find(
          (m) => m.messageID === occurrence.occurrenceID && m.role === "user",
        );
        if (!message) throw new Error("Missing trigger occurrence message");
        const { messageID, role, toolCalls, toolCallID, ...input } = message;
        if (
          createHash("sha256").update(canonical(input)).digest("hex") !==
          occurrence.inputHash
        )
          throw new Error("Trigger occurrence input mismatch");
      }
    }
    return r;
  }
  async write(r: Run, initial = false) {
    r.version = 2;
    runSchema.parse(r);
    this.checkedMessageIDs(r);
    const root = path.join(this.home, "runs");
    if (initial) {
      const staging = path.join(root, "." + randomUUID());
      await mkdir(staging, { mode: 0o700 });
      await atomicJSON(path.join(staging, "state.json"), r, 56 * 1024 * 1024);
      // The daemon lock serializes allocation; no externally supplied directory names.
      await rename(staging, path.join(root, r.runID));
      const h = await open(root, "r");
      try {
        await h.sync();
      } finally {
        await h.close();
      }
    } else
      await atomicJSON(
        path.join(root, r.runID, "state.json"),
        r,
        64 * 1024 * 1024,
      );
    this.index(r);
  }
  async saveConfig(next: Store) {
    storeSchema.parse(next);
    validateConfig(next);
    await atomicJSON(
      path.join(this.home, "config.json"),
      next,
      8 * 1024 * 1024,
    );
    this.store = next;
  }
  async close() {
    await this.tail;
    if (this.ownsLock) {
      await unlink(path.join(this.home, "daemon.lock"));
      this.ownsLock = false;
    }
  }
}

/** Bootstrap a new private home; the credential is returned once and never logged. */
export async function initializeHome(
  home: string,
  settings: Omit<
    Config,
    "revision" | "rootTokenHash" | "interactionCooldownMs"
  > & { interactionCooldownMs?: number },
) {
  checkpoint();
  if (!path.isAbsolute(home)) throw Error("Runtime home must be absolute");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const stat = await lstat(home);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new NightcrewError(
      "config.invalidHome",
      "Runtime home must be owner-only",
      3,
    );
  const token = randomBytes(32).toString("base64url");
  const store = storeSchema.parse({
    version: 2,
    config: {
      interactionCooldownMs: 300000,
      ...settings,
      revision: 1,
      rootTokenHash: tokenHash(token),
    },
    agents: [],
    cooldownUntil: null,
  });
  validateConfig(store);
  await claimJSON(path.join(home, "config.json"), store, 8 * 1024 * 1024);
  return { token };
}
