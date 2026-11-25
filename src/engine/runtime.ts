import { atomicJSON } from "../storage/store.js";
import { executionSlots, schedulerSchema } from "./scheduler.js";
import type { OperationalLog } from "../server/logging.js";
import {
  remainingTimeout,
  executionSignal,
  checkpoint,
  spawnOwned,
} from "./execution.js";
import { NightcrewError } from "./protocol.js";
import { execFile, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { userInfo, tmpdir, homedir } from "node:os";
import {
  access,
  realpath,
  lstat,
  mkdtemp,
  writeFile,
  rm,
  mkdir,
  readFile,
  readdir,
  unlink,
} from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { toolCallSchema, type Config } from "./contracts.js";
import type { Runtime, Presence, Result } from "./runtimeTypes.js";
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
  private binary?: string;
  private stopping: Promise<void> = Promise.resolve();
  async initialize() {
    await this.resolveBinary();
  }
  private child?: ChildProcess;
  private directory?: string;
  private baseURL = "";
  private key = randomBytes(32).toString("hex");
  private resident = new Map<string, string>();
  private idleTimer?: ReturnType<typeof setTimeout>;
  private busy = false;
  private warmUntil = 0;
  keepWarm(until: number) {
    if (until === this.warmUntil) return;
    this.warmUntil = until;
    if (this.loadedModel && !this.used.size)
      this.scheduleIdle(this.loadedModel);
  }
  private used = new Map<string, string>();
  private owners = new Map<string, string>();
  private contextEpochs = new Map<string, number>();
  private transientSlots = new Set<string>();
  private provisioning: Promise<void> = Promise.resolve();
  private loadedModel?: string;
  private loadingModel?: string;
  private unloadingModel?: string;
  isBusy() {
    return this.busy;
  }
  constructor(
    private config: () => Config,
    private home = path.join(homedir(), ".nightcrew"),
    private logger?: OperationalLog,
  ) {
    const source = this.config;
    this.config = () => {
      const config = source();
      return {
        ...config,
        scheduler: config.scheduler ?? schedulerSchema.parse({}),
        slots: executionSlots(config),
      };
    };
  }
  private snapshotDirectory(modelID: string) {
    const model = this.config().models.find((m) => m.modelID === modelID);
    if (!model?.slotSnapshots?.enabled)
      throw new NightcrewError(
        "runtime.snapshotsDisabled",
        "Enable slotSnapshots for this model first",
        3,
      );
    return path.join(
      model.slotSnapshots.directory ?? path.join(this.home, "slots"),
      modelID,
    );
  }
  private async privateDirectory(modelID: string) {
    const directory = this.snapshotDirectory(modelID);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (info.mode & 0o077) !== 0 ||
      info.uid !== process.getuid?.()
    )
      throw new NightcrewError(
        "config.snapshotDirectory",
        "Snapshot directory must be private and owned by this user",
        3,
      );
    return directory;
  }
  private async signature(modelID: string) {
    const model = this.config().models.find((m) => m.modelID === modelID)!;
    const files = [];
    for (const file of [
      model.weightsPath,
      model.projectorPath,
      await this.resolveBinary(),
    ].filter((v): v is string => !!v)) {
      const info = await lstat(file);
      files.push([await realpath(file), info.size, info.mtimeMs, info.ctimeMs]);
    }
    return createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          files,
          model,
          slots: this.config().slots.filter((s) => s.modelID === modelID),
        }),
      )
      .digest("hex");
  }
  private async eraseSlot(slotID: string, signal: AbortSignal) {
    const slot = this.config().slots.find((s) => s.slotID === slotID);
    if (!slot) throw Error("Unknown slot");
    const response = await fetch(
      this.baseURL +
        "/slots/" +
        slot.index +
        "?action=erase&model=" +
        encodeURIComponent(slot.modelID),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ model: slot.modelID }),
        signal,
      },
    );
    if (!response.ok)
      throw new NightcrewError(
        "runtime.snapshotResetFailed",
        "Failed to clear slot before context takeover",
        5,
      );
    await response.json();
  }
  private async slotAction(
    slotID: string,
    action: "save" | "restore",
    signal: AbortSignal,
    contextID = slotID,
    contextEpoch = 0,
  ) {
    const slot = this.config().slots.find((s) => s.slotID === slotID)!;
    const status = await fetch(
      this.baseURL + "/slots?model=" + encodeURIComponent(slot.modelID),
      { headers: this.headers(), signal },
    );
    const slots = z
      .array(
        z.object({ id: z.number().optional(), is_processing: z.boolean() }),
      )
      .parse(await status.json());
    const target = slots.find((s) => s.id === slot.index) ?? slots[slot.index];
    if (!status.ok || !target || target.is_processing)
      throw new NightcrewError(
        "runtime.busy",
        "Wait for model slots to become idle before saving or restoring",
        9,
      );
    const directory = await this.privateDirectory(slot.modelID);
    const manifest = path.join(directory, contextID + ".json");
    const signature = await this.signature(slot.modelID);
    let filename = contextID + "-" + randomUUID() + ".bin";
    let previous: string | undefined;
    try {
      const info = await lstat(manifest);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 8192)
        throw Error("Invalid snapshot manifest");
      const data = z
        .object({
          contextEpoch: z.number().int().nonnegative().default(0),
          signature: z.string(),
          filename: z.string().regex(/^[a-zA-Z0-9_-]+\.bin$/),
        })
        .parse(JSON.parse(await readFile(manifest, "utf8")));
      previous = data.filename;
      if (action === "restore") {
        if (data.signature !== signature || data.contextEpoch !== contextEpoch)
          throw new NightcrewError(
            "runtime.snapshotIncompatible",
            "Snapshot is incompatible with the current model or runtime settings",
            3,
          );
        filename = data.filename;
        const cache = await lstat(path.join(directory, filename));
        if (!cache.isFile() || cache.isSymbolicLink())
          throw Error("Invalid snapshot file");
      }
    } catch (error) {
      if (action === "restore") throw error;
    }
    const res = await fetch(
      this.baseURL +
        "/slots/" +
        slot.index +
        "?action=" +
        action +
        "&model=" +
        encodeURIComponent(slot.modelID),
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ filename, model: slot.modelID }),
        signal,
      },
    );
    if (!res.ok) {
      if (action === "restore") {
        const reset = await fetch(
          this.baseURL +
            "/slots/" +
            slot.index +
            "?action=erase&model=" +
            encodeURIComponent(slot.modelID),
          {
            method: "POST",
            headers: this.headers(),
            body: JSON.stringify({ model: slot.modelID }),
            signal,
          },
        );
        if (!reset.ok)
          throw new NightcrewError(
            "runtime.snapshotResetFailed",
            "Failed to clear a rejected snapshot",
            5,
          );
        await reset.json();
      }
      throw new NightcrewError(
        "runtime.snapshotFailed",
        "Slot " + action + " failed",
        5,
      );
    }
    await res.json();
    if (action === "save") {
      const info = await lstat(path.join(directory, filename));
      if (!info.isFile() || info.isSymbolicLink())
        throw Error("Invalid saved snapshot");
      signal.throwIfAborted();
      await atomicJSON(
        manifest,
        { signature, filename, contextEpoch },
        1024 * 1024,
      );
      if (previous && previous !== filename)
        await unlink(path.join(directory, previous)).catch(() => {});
    }
  }
  private async saveLoaded() {
    if (
      this.config().scheduler.snapshotBudgetMB === 0 ||
      !this.loadedModel ||
      !this.config().models.find((m) => m.modelID === this.loadedModel)
        ?.slotSnapshots?.enabled
    )
      return;
    const signal = AbortSignal.timeout(60000);
    for (const slot of this.config().slots.filter(
      (s) => s.modelID === this.loadedModel,
    )) {
      if (this.transientSlots.has(slot.slotID)) continue;
      try {
        await this.slotAction(
          slot.slotID,
          "save",
          signal,
          this.owners.get(slot.slotID),
          this.contextEpochs.get(slot.slotID),
        );
      } catch {
        this.logger?.emit("slot.snapshotSaveFailed", {
          slotID: slot.slotID,
          reason: "transport",
        });
      }
    }
  }
  private async prepare(modelID: string, signal: AbortSignal, restore = true) {
    this.loadingModel = this.loadedModel === modelID ? undefined : modelID;
    try {
    const switchStarted = performance.now();
    const switching =
      this.loadedModel !== undefined && this.loadedModel !== modelID;
    if (this.loadedModel && this.loadedModel !== modelID) await this.stop();
    await this.start(signal);
    if (this.loadedModel === modelID) return;
    const model = this.config().models.find((m) => m.modelID === modelID)!;
    if (model.slotSnapshots?.enabled) {
      const response = await fetch(this.baseURL + "/models/load", {
        method: "POST",
        headers: this.headers(),
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
            await this.slotAction(slot.slotID, "restore", signal);
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
  async snapshot(slotID: string, action: "save" | "restore", dryRun = false) {
    if (this.busy || this.used.size)
      throw new NightcrewError(
        "runtime.busy",
        "Inference or another slot operation is active",
        9,
      );
    const slot = this.config().slots.find((s) => s.slotID === slotID);
    if (!slot)
      throw new NightcrewError("resource.notFound", "Slot not found", 7);
    const directory = this.snapshotDirectory(slot.modelID);
    if (dryRun) return { slotID, action, changed: false, directory };
    this.busy = true;
    clearTimeout(this.idleTimer);
    try {
      const signal = executionSignal() ?? AbortSignal.timeout(90000);
      if (action === "save" && this.loadedModel !== slot.modelID)
        throw new NightcrewError(
          "runtime.modelUnloaded",
          "Cannot save an unloaded model",
          9,
        );
      if (action === "restore") await this.prepare(slot.modelID, signal, false);
      await this.slotAction(slotID, action, signal);
      return { slotID, action, changed: true, directory };
    } finally {
      this.busy = false;
      this.scheduleIdle(slot.modelID);
    }
  }
  private scheduleIdle(modelID: string) {
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
              : (this.resident.get(m.modelID) ?? "unloaded"),
    }));
  }
  private async resolveBinary() {
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
  private async start(signal: AbortSignal) {
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
    for (const model of this.config().models) {
      const slots = this.config().slots.filter(
        (s) => s.modelID === model.modelID,
      );
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
          "slot-save-path = " + (await this.privateDirectory(model.modelID)),
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
        this.logger?.emit("runtime.unexpectedExit", {
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
          this.logger?.emit("runtime.ready", { pid: child.pid });
          return;
        }
      } catch {}
      await delay(100);
    }
    throw Error("llama-server startup timed out");
  }
  private headers() {
    return {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }
  private formatMessages(
    messages: Parameters<Runtime["generate"]>[0]["messages"],
  ) {
    return messages.map((m) => ({
      role: m.role,
      content:
        m.content +
        m.attachments
          .map(
            (a) =>
              `\n\nAttachment ${JSON.stringify(a.name)} (${a.mediaType}):\n${Buffer.from(a.dataBase64, "base64").toString("utf8")}`,
          )
          .join(""),
      ...(m.toolCalls.length
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.callID,
              type: "function",
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
      ...(m.toolCallID ? { tool_call_id: m.toolCallID } : {}),
    }));
  }
  async countTokens(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
  ): Promise<number> {
    if (
      this.busy ||
      this.used.has(input.slotID) ||
      [...this.used.values()].some((m) => m !== input.modelID)
    )
      throw Error("Runtime busy");
    this.used.set(input.slotID, input.modelID);
    clearTimeout(this.idleTimer);
    try {
      const prepare = this.provisioning.then(() =>
        this.prepare(input.modelID, signal),
      );
      this.provisioning = prepare.catch(() => {});
      await prepare;
      const post = async (endpoint: string, body: object) => {
        const response = await fetch(this.baseURL + endpoint, {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify({ model: input.modelID, ...body }),
        });
        if (!response.ok) {
          const reader = response.body?.getReader();
          let detail = "";
          if (reader) {
            try {
              while (detail.length < 4000) {
                const chunk = await reader.read();
                if (chunk.done) break;
                detail += Buffer.from(chunk.value).toString("utf8");
              }
            } finally {
              await reader.cancel().catch(() => {});
            }
          }
          const error = new Error(
            `Context preparation ${endpoint} returned HTTP ${response.status}: ${detail.slice(0, 1500) || response.statusText}`,
          );
          error.name = "ContextPreparationError";
          throw error;
        }
        return response.json();
      };
      const template = z.object({ prompt: z.string() }).parse(
        await post("/apply-template", {
          messages: this.formatMessages(input.messages),
          tools: input.tools.map((t) => ({ type: "function", function: t })),
          ...(input.sampling?.parallelToolCalls === undefined
            ? {}
            : { parallel_tool_calls: input.sampling.parallelToolCalls }),
          add_generation_prompt: !input.continueFinalMessage,
          ...(input.continueFinalMessage ? { continue_final_message: "content" } : {}),
          chat_template_kwargs: { enable_thinking: input.thinking ?? true },
        }),
      );
      const tokens = z.object({ tokens: z.array(z.number()) }).parse(
        await post("/tokenize", {
          content: template.prompt,
          add_special: false,
          parse_special: true,
        }),
      );
      return tokens.tokens.length;
    } catch (cause) {
      signal.throwIfAborted();
      const error = cause instanceof Error ? cause : new Error(String(cause));
      error.name = "ContextPreparationError";
      throw error;
    } finally {
      this.used.delete(input.slotID);
      if (!this.used.size) this.scheduleIdle(input.modelID);
    }
  }
  async generate(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onEvidence?: Parameters<Runtime["generate"]>[3],
  ): Promise<Result> {
    if (
      this.busy ||
      this.used.has(input.slotID) ||
      [...this.used.values()].some((model) => model !== input.modelID)
    )
      throw new NightcrewError(
        "runtime.busy",
        "Requested model or slot is busy",
        9,
      );
    this.used.set(input.slotID, input.modelID);
    clearTimeout(this.idleTimer);
    try {
      const prepare = this.provisioning.then(() =>
        this.prepare(input.modelID, signal),
      );
      this.provisioning = prepare.catch(() => {});
      await prepare;
      signal.throwIfAborted();
      if (
        input.contextID &&
        (this.owners.get(input.slotID) !== input.contextID ||
          this.contextEpochs.get(input.slotID) !== (input.contextEpoch ?? 0))
      ) {
        await this.eraseSlot(input.slotID, signal);
        this.owners.delete(input.slotID);
        if (
          input.persistContext !== false &&
          this.config().scheduler.snapshotBudgetMB > 0 &&
          this.config().models.find((m) => m.modelID === input.modelID)
            ?.slotSnapshots.enabled
        ) {
          try {
            await this.slotAction(
              input.slotID,
              "restore",
              signal,
              input.contextID,
              input.contextEpoch,
            );
          } catch (error) {
            signal.throwIfAborted();
            if (
              error instanceof NightcrewError &&
              error.code === "runtime.snapshotResetFailed"
            )
              throw error;
          }
        }
        this.owners.set(input.slotID, input.contextID);
        this.contextEpochs.set(input.slotID, input.contextEpoch ?? 0);
      } else if (!input.contextID) this.owners.delete(input.slotID);
      if (input.persistContext === false) this.transientSlots.add(input.slotID);
      else this.transientSlots.delete(input.slotID);
      const slot = this.config().slots.find(
        (s) => s.slotID === input.slotID && s.modelID === input.modelID,
      );
      if (!slot) throw Error("Unknown slot");
      this.resident.clear();
      this.resident.set(input.modelID, "ready");
      const model = this.config().models.find(
        (m) => m.modelID === input.modelID,
      )!;
      let response: Response;
      if (model.kind === "audio") {
        const a = input.messages
          .at(-1)
          ?.attachments.find((x) => x.mediaType === "audio/wav");
        if (!a) throw Error("WAV required");
        const form = new FormData();
        form.set("model", input.modelID);
        const prompt = [...input.messages]
          .reverse()
          .find((m) => m.role === "user")?.content;
        if (prompt?.trim()) form.set("prompt", prompt);
        form.set("response_format", "json");
        form.set("temperature", String(input.temperature));
        form.set("max_tokens", String(input.maxOutputTokens));
        form.set(
          "file",
          new Blob([Uint8Array.from(Buffer.from(a.dataBase64, "base64"))], {
            type: "audio/wav",
          }),
          "input.wav",
        );
        response = await fetch(this.baseURL + "/v1/audio/transcriptions", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.key}` },
          body: form,
          signal,
        });
      } else {
        const messages = this.formatMessages(input.messages);
        response = await fetch(this.baseURL + "/v1/chat/completions", {
          method: "POST",
          headers: this.headers(),
          signal,
          body: JSON.stringify({
            model: input.modelID,
            id_slot: slot.index,
            cache_prompt: true,
            ...(input.continueFinalMessage
              ? { continue_final_message: "content", add_generation_prompt: false }
              : {}),
            messages,
            tools: input.tools.map((t) => ({ type: "function", function: t })),
            tool_choice: input.tools.length ? "auto" : "none",
            ...(input.thinking === undefined
              ? {}
              : { chat_template_kwargs: { enable_thinking: input.thinking } }),
            ...(input.reasoningBudgetTokens === undefined
              ? {}
              : { reasoning_budget_tokens: input.reasoningBudgetTokens }),
            max_tokens: input.maxOutputTokens,
            temperature: input.temperature,
            ...(input.sampling
              ? {
                  top_p: input.sampling.topP,
                  top_k: input.sampling.topK,
                  min_p: input.sampling.minP,
                  presence_penalty: input.sampling.presencePenalty,
                  repeat_penalty: input.sampling.repeatPenalty,
                  parallel_tool_calls: input.sampling.parallelToolCalls,
                }
              : {}),
            stream: true,
            stream_options: { include_usage: true },
          }),
        });
      }
      if (!response.ok) throw Error("Model request failed");
      if (!response.body) throw Error("Empty model response");
      if (model.kind === "chat")
        return await this.readStream(
          response,
          signal,
          onDelta,
          input.thinking !== false,
          onEvidence,
          input.continueOnOutputLimit,
        );
      const reader = response.body.getReader();
      let bytes = 0;
      const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 2 * 1024 * 1024) throw Error("Model output limit");
          chunks.push(value);
        }
      } finally {
        await reader.cancel();
      }
      const data: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const parsed = z.object({ text: z.string().max(1048576) }).parse(data);
      return {
        text: parsed.text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0 },
      };
    } catch (e) {
      if (signal.aborted) {
        await this.release(input.modelID, input.slotID);
      } else {
        await this.release(input.modelID, input.slotID);
      }
      throw e;
    } finally {
      if (
        input.contextID &&
        input.persistContext !== false &&
        this.owners.get(input.slotID) === input.contextID &&
        this.config().scheduler.snapshotBudgetMB > 0 &&
        this.config().models.find((m) => m.modelID === input.modelID)
          ?.slotSnapshots.enabled &&
        this.loadedModel === input.modelID
      ) {
        try {
          await this.slotAction(
            input.slotID,
            "save",
            AbortSignal.timeout(5000),
            input.contextID,
            input.contextEpoch,
          );
          await this.pruneSnapshots();
        } catch {
          this.logger?.emit("slot.snapshotSaveFailed", {
            slotID: input.slotID,
            reason: "transport",
          });
        }
      }
      this.used.delete(input.slotID);
      if (!this.used.size) this.scheduleIdle(input.modelID);
    }
  }
  private async readStream(
    response: Response,
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    captureThinking = true,
    onEvidence?: Parameters<Runtime["generate"]>[3],
    continueOnOutputLimit = false,
  ): Promise<Result> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "",
      text = "",
      reasoningContent = "",
      finish = "";
    let total = 0;
    let ended = false;
    const calls = new Map<
      number,
      { callID: string; name: string; arguments: string }
    >();
    let usage = { inputTokens: 0, outputTokens: 0 };
    const chunkSchema = z.object({
      choices: z.array(
        z.object({
          index: z.number().int(),
          finish_reason: z.string().nullable().optional(),
          delta: z.object({
            content: z.string().nullable().optional(),
            reasoning_content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  index: z.number().int().min(0).max(31),
                  id: z.string().optional(),
                  function: z
                    .object({
                      name: z.string().optional(),
                      arguments: z.string().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          }),
        }),
      ),
      usage: z
        .object({
          prompt_tokens: z.number().nonnegative(),
          completion_tokens: z.number().nonnegative(),
        })
        .nullable()
        .optional(),
    });
    const line = (value: string) => {
      if (!value.startsWith("data:")) return;
      const payload = value.slice(5).trim();
      if (payload === "[DONE]") {
        ended = true;
        return;
      }
      const chunk = chunkSchema.parse(JSON.parse(payload));
      if (chunk.usage)
        usage = {
          inputTokens: chunk.usage.prompt_tokens,
          outputTokens: chunk.usage.completion_tokens,
        };
      for (const choice of chunk.choices) {
        if (choice.index !== 0) continue;
        if (choice.finish_reason) finish = choice.finish_reason;
        if (choice.delta.content) {
          text += choice.delta.content;
          onDelta?.(choice.delta.content);
        }
        if (captureThinking && choice.delta.reasoning_content) {
          reasoningContent += choice.delta.reasoning_content;
          if (Buffer.byteLength(reasoningContent) > 1048576) {
            onEvidence?.({
              reasoningContent,
              toolCalls: [...calls.entries()].map(([index, c]) => ({
                index,
                ...c,
              })),
            });
            throw Error("Reasoning output limit");
          }
        }
        for (const part of choice.delta.tool_calls ?? []) {
          const call = calls.get(part.index) ?? {
            callID: "",
            name: "",
            arguments: "",
          };
          if (part.id) call.callID = part.id;
          call.name += part.function?.name ?? "";
          call.arguments += part.function?.arguments ?? "";
          calls.set(part.index, call);
        }
        onEvidence?.({
          reasoningContent,
          toolCalls: [...calls.entries()].map(([index, c]) => ({
            index,
            ...c,
          })),
        });
      }
    };
    try {
      while (!ended) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > 4 * 1024 * 1024) throw Error("Output limit");
        buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          line(buffer.slice(0, index).replace(/\r$/, ""));
          buffer = buffer.slice(index + 1);
        }
      }
      if (buffer.trim()) line(buffer.trim());
    } finally {
      await reader.cancel();
    }
    if (!ended || !["stop", "tool_calls", ...(continueOnOutputLimit ? ["length"] : [])].includes(finish))
      throw Error("Incomplete generation");
    return {
      ...(finish === "length" ? { outputLimitReached: true } : {}),
      text,
      ...(captureThinking && reasoningContent ? { reasoningContent } : {}),
      // A length-limited tool call may not even contain valid JSON or an ID.
      // Preserve fragments through onEvidence, never expose them for execution.
      toolCalls: finish === "length" ? [] : [...calls.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, c]) => toolCallSchema.parse(c)),
      usage,
    };
  }
  private async release(modelID: string, slotID: string) {
    const index = this.config().slots.find((s) => s.slotID === slotID)?.index;
    // HTTP cancellation alone is insufficient: observe all slots idle before reuse.
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(
          this.baseURL + "/slots?model=" + encodeURIComponent(modelID),
          { headers: this.headers(), signal: AbortSignal.timeout(250) },
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
    await this.stop();
  }
  private async stop() {
    const operation = this.stopping.then(() => this.stopOwned());
    this.stopping = operation.catch(() => {});
    await operation;
  }
  private async stopOwned() {
    clearTimeout(this.idleTimer);
    await this.saveLoaded();
    await this.pruneSnapshots().catch(() => {});
    this.loadedModel = undefined;
    this.owners.clear();
    this.contextEpochs.clear();
    this.transientSlots.clear();
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
    this.resident.clear();
    if (this.directory) {
      await rm(this.directory, { recursive: true, force: true });
      this.directory = undefined;
    }
  }
  async contextCache(contextID: string, reset: boolean, dryRun = false) {
    if (!/^[a-zA-Z0-9_-]+$/.test(contextID))
      throw Error("Invalid context identity");
    if (reset && (this.busy || this.used.size))
      throw new NightcrewError(
        "runtime.busy",
        "Wait for inference to settle before resetting caches",
        9,
      );
    if (reset) this.busy = true;
    try {
      const items = [];
      for (const model of this.config().models.filter(
        (m) => m.slotSnapshots.enabled,
      )) {
        const directory = this.snapshotDirectory(model.modelID);
        const manifest = path.join(directory, contextID + ".json");
        try {
          const dir = await lstat(directory),
            meta = await lstat(manifest);
          if (
            !dir.isDirectory() ||
            dir.isSymbolicLink() ||
            !meta.isFile() ||
            meta.isSymbolicLink() ||
            meta.size > 8192
          )
            throw Error("Invalid cache directory or manifest");
          const data = JSON.parse(await readFile(manifest, "utf8"));
          if (
            typeof data.filename !== "string" ||
            !/^[a-zA-Z0-9_-]+\.bin$/.test(data.filename)
          )
            throw Error("Invalid cache filename");
          const file = path.join(directory, data.filename),
            stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink())
            throw Error("Invalid cache file");
          items.push({
            modelID: model.modelID,
            bytes: stat.size,
            updatedAt: meta.mtime.toISOString(),
          });
          if (reset && !dryRun) {
            await unlink(manifest);
            await unlink(file);
            for (const [slot, owner] of this.owners)
              if (owner === contextID) this.owners.delete(slot);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      return {
        contextID,
        items,
        changed: reset && !dryRun && items.length > 0,
      };
    } finally {
      if (reset) this.busy = false;
    }
  }
  async pruneSnapshots() {
    const caches: {
      manifest: string;
      file: string;
      bytes: number;
      mtime: number;
    }[] = [];
    for (const model of this.config().models.filter(
      (m) => m.slotSnapshots.enabled,
    )) {
      const directory = await this.privateDirectory(model.modelID);
      for (const name of await readdir(directory)) {
        if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) continue;
        try {
          const manifest = path.join(directory, name),
            meta = await lstat(manifest);
          if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 8192)
            continue;
          const data = JSON.parse(await readFile(manifest, "utf8"));
          if (
            typeof data.filename !== "string" ||
            !/^[a-zA-Z0-9_-]+\.bin$/.test(data.filename)
          )
            continue;
          const file = path.join(directory, data.filename),
            stat = await lstat(file);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          caches.push({
            manifest,
            file,
            bytes: stat.size + meta.size,
            mtime: meta.mtimeMs,
          });
        } catch {}
      }
    }
    let bytes = caches.reduce((n, c) => n + c.bytes, 0);
    for (const cache of caches.sort((a, b) => a.mtime - b.mtime)) {
      if (bytes <= this.config().scheduler.snapshotBudgetMB * 1024 * 1024)
        break;
      await unlink(cache.manifest);
      await unlink(cache.file).catch(() => {});
      bytes -= cache.bytes;
    }
  }
  async close() {
    if (this.busy || this.used.size)
      throw new NightcrewError("runtime.busy", "Runtime is busy", 9);
    this.busy = true;
    this.unloadingModel = this.loadedModel;
    try {
      await this.stop();
    } finally {
      this.unloadingModel = undefined;
      this.busy = false;
    }
  }
}
