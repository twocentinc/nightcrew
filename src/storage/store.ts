import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { checkpoint } from "../engine/execution/process.js";
import { NightcrewError } from "../engine/protocol.js";
import { type Store } from "../schemas/config.js";
import { type Run } from "../schemas/run.js";
import type { OperationalLog } from "../server/logging.js";
import { ConfigStore } from "./config.js";
import { regular } from "./files.js";
import { RunIndex } from "./runIndex.js";
import { TranscriptStore } from "./transcript.js";

export class Storage {
  readonly runIndex: RunIndex;
  private readonly configuration: ConfigStore;
  private readonly transcripts: TranscriptStore;
  constructor(
    readonly home: string,
    private logger?: OperationalLog,
  ) {
    if (!path.isAbsolute(home))
      throw new Error("Runtime home must be absolute");

    this.runIndex = new RunIndex({ main: this });
    this.configuration = new ConfigStore(home);
    this.transcripts = new TranscriptStore(home, this.runIndex, logger);
  }

  private tail: Promise<unknown> = Promise.resolve();
  private ownsLock = false;
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
      await this.configuration.load();
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
          this.runIndex.unreadable.push(entry.name);
          continue;
        }
        try {
          this.runIndex.index(await this.read(entry.name));
        } catch {
          this.runIndex.unreadable.push(entry.name);
        }
      }
    } catch (e) {
      await this.close();
      throw e;
    }
  }

  async close() {
    await this.tail;
    if (this.ownsLock) {
      await unlink(path.join(this.home, "daemon.lock"));
      this.ownsLock = false;
    }
  }
  get summaries() {
    return this.runIndex.summaries;
  }
  set summaries(value: RunIndex["summaries"]) {
    this.runIndex.summaries = value;
  }
  get messages() {
    return this.runIndex.messages;
  }
  set messages(value: RunIndex["messages"]) {
    this.runIndex.messages = value;
  }
  get unreadable() {
    return this.runIndex.unreadable;
  }
  set unreadable(value: RunIndex["unreadable"]) {
    this.runIndex.unreadable = value;
  }
  get pendingRunIDs() {
    return this.runIndex.pendingRunIDs;
  }
  get compactingRunIDs() {
    return this.runIndex.compactingRunIDs;
  }
  reconcile() {
    return this.runIndex.reconcile();
  }

  get store() {
    return this.configuration.store;
  }
  set store(value: Store) {
    this.configuration.store = value;
  }
  read(runID: string) {
    return this.transcripts.read(runID);
  }
  write(run: Run, initial = false) {
    return this.transcripts.write(run, initial);
  }
  saveConfig(next: Store) {
    return this.configuration.save(next);
  }
}
