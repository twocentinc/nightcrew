import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { type Config } from "../../schemas/config.js";
import type { OperationalLog } from "../../server/logging.js";
import { executionSignal, remainingTimeout } from "../execution/process.js";
import { NightcrewError } from "../protocol.js";
import { executionSlots } from "../scheduling/policy.js";
import { ModelCache } from "./cache.js";
import { ModelClient } from "./client.js";
import { ModelServer } from "./server.js";
import type { Presence, Result, Runtime } from "./types.js";

const exec = promisify(execFile);
export async function samplePresence(): Promise<Presence> {
  const base = { observedAt: new Date().toISOString(), diagnostic: null };
  if (process.platform !== "darwin")
    return {
      ...base,
      state: "present",
      reason: "samplingFailure",
      samplingHealthy: false,
      diagnostic: "Desktop presence requires macOS",
    };
  const options = {
    timeout: remainingTimeout(5000),
    signal: executionSignal(),
    maxBuffer: 4 * 1024 * 1024,
  };
  const [consoleState, hid, user] = await Promise.all([
    exec("/usr/sbin/ioreg", ["-n", "Root", "-d1", "-l", "-w0"], options),
    exec(
      "/usr/sbin/ioreg",
      ["-c", "IOHIDSystem", "-d", "1", "-r", "-k", "HIDIdleTime"],
      options,
    ),
    exec("/usr/bin/stat", ["-f", "%Su", "/dev/console"], options),
  ]);
  const idle = /"HIDIdleTime"\s*=\s*(\d+)/.exec(hid.stdout);
  if (!idle || !user.stdout.trim()) throw Error("Invalid presence sample");
  const locked =
    /"(?:IOConsoleLocked|CGSSessionScreenIsLocked)"\s*=\s*Yes/.test(
      consoleState.stdout,
    );
  const reason = locked
    ? "locked"
    : user.stdout.trim() !== userInfo().username
      ? "switchedOut"
      : Number(idle[1]) / 1000000 >= 600000
        ? "idle"
        : "activeInput";
  return {
    ...base,
    state: reason === "activeInput" ? "present" : "away",
    reason,
    samplingHealthy: true,
  };
}

export class LlamaRuntime implements Runtime {
  readonly server: ModelServer;
  readonly cache: ModelCache;
  readonly client: ModelClient;
  config: () => Config & { slots: ReturnType<typeof executionSlots> };
  constructor(
    config: () => Config,
    public home = path.join(homedir(), ".nightcrew"),
    public logger?: OperationalLog,
  ) {
    const source = config;
    this.config = () => {
      const config = source();
      return {
        ...config,
        slots: executionSlots(config),
      };
    };

    const self = this;
    this.server = new ModelServer({
      main: this,
      get cache() {
        return self.cache;
      },
    });
    this.cache = new ModelCache({
      main: this,
      get server() {
        return self.server;
      },
    });
    this.client = new ModelClient({
      main: this,
      get server() {
        return self.server;
      },
      get cache() {
        return self.cache;
      },
    });
  }
  async initialize() {
    await this.server.resolveBinary();
  }
  idleTimer?: ReturnType<typeof setTimeout>;
  busy = false;
  private warmUntil = 0;
  keepWarm(until: number) {
    if (until === this.warmUntil) return;
    this.warmUntil = until;
    if (this.loadedModel && !this.used.size)
      this.scheduleIdle(this.loadedModel);
  }
  used = new Map<string, string>();
  provisioning: Promise<void> = Promise.resolve();
  loadedModel?: string;
  private loadingModel?: string;
  private unloadingModel?: string;
  isBusy() {
    return this.busy;
  }
  async prepare(modelID: string, signal: AbortSignal, restore = true) {
    this.loadingModel = this.loadedModel === modelID ? undefined : modelID;
    try {
      const switchStarted = performance.now();
      const switching =
        this.loadedModel !== undefined && this.loadedModel !== modelID;
      if (this.loadedModel && this.loadedModel !== modelID)
        await this.server.stop();
      await this.server.start(signal);
      if (this.loadedModel === modelID) return;
      const model = this.config().models.find((m) => m.modelID === modelID)!;
      if (model.slotSnapshots?.enabled) {
        const response = await fetch(this.server.baseURL + "/models/load", {
          method: "POST",
          headers: this.server.headers(),
          body: JSON.stringify({ model: modelID }),
          signal,
        });
        if (!response.ok) throw Error("Model load failed");
        await response.json();
        this.loadedModel = modelID;
        if (restore)
          for (const slot of this.config().slots.filter(
            (s) => s.modelID === modelID,
          )) {
            try {
              await this.cache.slotAction(slot.slotID, "restore", signal);
            } catch (error) {
              if (
                error instanceof NightcrewError &&
                error.code === "runtime.snapshotResetFailed"
              )
                throw error;
              signal.throwIfAborted();
              if (
                !["ENOENT", "runtime.snapshotIncompatible"].includes(
                  (error as NodeJS.ErrnoException)?.code ?? "",
                )
              )
                this.logger?.emit("slot.snapshotRestoreFailed", {
                  slotID: slot.slotID,
                  reason: "invalid_cache",
                });
            }
          }
      }
      this.loadedModel = modelID;
      if (switching)
        this.logger?.emit("runtime.modelSwitched", {
          modelID,
          durationMs: Math.round(performance.now() - switchStarted),
        });
    } finally {
      this.loadingModel = undefined;
    }
  }
  scheduleIdle(modelID: string) {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => {
        if (!this.busy && !this.used.size) void this.close().catch(() => {});
      },
      Math.max(
        this.config().models.find((m) => m.modelID === modelID)?.idleUnloadMs ??
          0,
        this.warmUntil - Date.now(),
      ),
    );
    this.idleTimer.unref();
  }
  status() {
    return this.config().models.map((m) => ({
      modelID: m.modelID,
      state:
        this.unloadingModel === m.modelID
          ? "unloading"
          : this.loadingModel === m.modelID
            ? "loading"
            : this.loadedModel === m.modelID
              ? "ready"
              : "unloaded",
    }));
  }
  async release(modelID: string, slotID: string) {
    const index = this.config().slots.find((s) => s.slotID === slotID)?.index;
    // HTTP cancellation alone is insufficient: observe all slots idle before reuse.
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(
          this.server.baseURL + "/slots?model=" + encodeURIComponent(modelID),
          { headers: this.server.headers(), signal: AbortSignal.timeout(250) },
        );
        const body: unknown = await res.json();
        if (
          res.ok &&
          Array.isArray(body) &&
          body.length > 0 &&
          body.some(
            (s, i) =>
              s &&
              typeof s === "object" &&
              (("id" in s && s.id === index) ||
                (!("id" in s) && i === index)) &&
              "is_processing" in s &&
              s.is_processing === false,
          )
        )
          return;
      } catch {}
      await delay(100);
    }
    await this.server.stop();
  }
  async close() {
    if (this.busy || this.used.size)
      throw new NightcrewError("runtime.busy", "Runtime is busy", 9);
    this.busy = true;
    this.unloadingModel = this.loadedModel;
    try {
      await this.server.stop();
    } finally {
      this.unloadingModel = undefined;
      this.busy = false;
    }
  }
  snapshot(slotID: string, action: "save" | "restore", dryRun = false) {
    return this.cache.snapshot(slotID, action, dryRun);
  }
  countTokens(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
  ): Promise<number> {
    return this.client.countTokens(input, signal);
  }
  generate(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onEvidence?: Parameters<Runtime["generate"]>[3],
  ): Promise<Result> {
    return this.client.generate(input, signal, onDelta, onEvidence);
  }
  contextCache(contextID: string, reset: boolean, dryRun = false) {
    return this.cache.contextCache(contextID, reset, dryRun);
  }
  pruneSnapshots() {
    return this.cache.pruneSnapshots();
  }
}
