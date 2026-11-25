import { execFile, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  lstat,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import {
  checkpoint,
  executionSignal,
  remainingTimeout,
  spawnOwned,
} from "../execution/process.js";
import { NightcrewError } from "../protocol.js";
import type { ModelCache } from "./cache.js";
import type { LlamaRuntime } from "./runtime.js";

const exec = promisify(execFile);
interface Dependencies {
  readonly main: Pick<
    LlamaRuntime,
    "config" | "logger" | "idleTimer" | "loadedModel" | "resident"
  >;
  readonly cache: Pick<
    ModelCache,
    | "privateDirectory"
    | "saveLoaded"
    | "pruneSnapshots"
    | "owners"
    | "contextEpochs"
    | "transientSlots"
  >;
}
export class ModelServer {
  constructor(private readonly ports: Dependencies) {}
  private binary?: string;
  private stopping: Promise<void> = Promise.resolve();
  private child?: ChildProcess;
  private directory?: string;
  baseURL = "";
  key = randomBytes(32).toString("hex");
  async resolveBinary() {
    if (this.binary) return this.binary;
    for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
      if (!path.isAbsolute(dir)) continue;
      const candidate = path.join(dir, "llama-server");
      try {
        await access(candidate, constants.X_OK);
        const { stdout, stderr } = await exec(candidate, ["--help"], {
          timeout: remainingTimeout(10000),
          signal: executionSignal(),
          maxBuffer: 2 * 1024 * 1024,
        });
        const help = stdout + stderr;
        if (
          ![
            "--models-preset",
            "--parallel",
            "--slots",
            "--kv-unified-per-slot",
          ].every((flag) => help.includes(flag))
        )
          throw Error("Unsupported llama-server build");
        this.binary = await realpath(candidate);
        return this.binary;
      } catch {
        continue;
      }
    }
    checkpoint();
    throw new NightcrewError(
      "runtime.llamaUnavailable",
      "Compatible llama-server not found on PATH",
      5,
    );
  }
  async start(signal: AbortSignal) {
    await this.stopping;
    if (
      this.child?.exitCode === null &&
      this.child.signalCode === null &&
      !this.child.killed
    )
      return;
    const binary = await this.resolveBinary();
    signal.throwIfAborted();
    this.directory = await mkdtemp(path.join(tmpdir(), "nightcrew-"));
    const sections = ["version = 1"];
    for (const model of this.ports.main.config().models) {
      const slots = this.ports.main
        .config()
        .slots.filter((s) => s.modelID === model.modelID);
      if (!slots.length) continue;
      for (const filename of [model.weightsPath, model.projectorPath].filter(
        (x): x is string => !!x,
      )) {
        if (
          !path.isAbsolute(filename) ||
          /[\r\n]/.test(filename) ||
          !(await lstat(filename)).isFile()
        )
          throw Error("Model file unavailable");
      }
      sections.push(
        `[${model.modelID}]`,
        `model = ${model.weightsPath}`,
        `parallel = ${slots.length}`,
        `ctx-size = ${slots.reduce((sum, s) => sum + s.contextTokens, 0)}`,
        `kv-unified = true`,
        `kv-unified-per-slot = ${slots[0]!.contextTokens}`,
        "jinja = true",
        "cache-prompt = true",
        "context-shift = false",
        "load-on-startup = false",
      );
      if (model.kind === "chat") sections.push("reasoning-format = deepseek");
      if (model.slotSnapshots?.enabled)
        sections.push(
          "slot-save-path = " +
            (await this.ports.cache.privateDirectory(model.modelID)),
        );
      if (model.projectorPath) sections.push(`mmproj = ${model.projectorPath}`);
    }
    const preset = path.join(this.directory, "models.ini");
    await writeFile(preset, sections.join("\n") + "\n", { mode: 0o600 });
    const socket = createServer();
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.listen(0, "127.0.0.1", resolve);
    });
    const address = socket.address();
    if (!address || typeof address === "string")
      throw Error("Port unavailable");
    const port = address.port;
    await new Promise<void>((resolve, reject) =>
      socket.close((e) => (e ? reject(e) : resolve())),
    );
    this.baseURL = `http://127.0.0.1:${port}`;
    const child = spawnOwned(
      binary,
      [
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--models-preset",
        preset,
        "--models-max",
        "1",
        "--api-key",
        this.key,
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        env: {
          PATH: process.env.PATH ?? "",
          HOME: this.directory,
          LLAMA_CACHE: this.directory,
        },
      },
    );
    this.child = child;
    child.on("exit", (code) => {
      if (this.child === child)
        this.ports.main.logger?.emit("runtime.unexpectedExit", {
          ...(code === null ? {} : { exitCode: code }),
          reason: "process",
        });
    });
    let spawnError: Error | undefined;
    child.on("error", (e) => {
      spawnError = e;
    });
    for (let i = 0; i < 100; i++) {
      signal.throwIfAborted();
      if (spawnError || child.exitCode !== null || child.signalCode !== null)
        throw Error("llama-server startup failed");
      try {
        const res = await fetch(this.baseURL + "/health", {
          headers: this.headers(),
          signal: AbortSignal.timeout(500),
        });
        if (res.ok) {
          this.ports.main.logger?.emit("runtime.ready", { pid: child.pid });
          return;
        }
      } catch {}
      await delay(100);
    }
    throw Error("llama-server startup timed out");
  }
  headers() {
    return {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }
  async stop() {
    const operation = this.stopping.then(() => this.stopOwned());
    this.stopping = operation.catch(() => {});
    await operation;
  }
  private async stopOwned() {
    clearTimeout(this.ports.main.idleTimer);
    await this.ports.cache.saveLoaded();
    await this.ports.cache.pruneSnapshots().catch(() => {});
    this.ports.main.loadedModel = undefined;
    this.ports.cache.owners.clear();
    this.ports.cache.contextEpochs.clear();
    this.ports.cache.transientSlots.clear();
    const child = this.child;
    this.child = undefined;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      const timer = setTimeout(() => {
        try {
          process.kill(-child.pid!, "SIGKILL");
        } catch {}
      }, 2000);
      await exited;
      clearTimeout(timer);
      // Router descendants share this owned process group. A surviving child must be stopped.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
    }
    this.ports.main.resident.clear();
    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
    }
  }
}
