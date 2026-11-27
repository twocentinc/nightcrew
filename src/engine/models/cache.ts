import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { atomicJSON } from "../../storage/files.js";
import { executionSignal } from "../execution/process.js";
import { NightcrewError } from "../protocol.js";
import type { LlamaRuntime } from "./runtime.js";
import type { ModelServer } from "./server.js";

interface Dependencies {
  readonly main: Pick<
    LlamaRuntime,
    | "config"
    | "home"
    | "loadedModel"
    | "logger"
    | "busy"
    | "used"
    | "idleTimer"
    | "prepare"
    | "scheduleIdle"
  >;
  readonly server: Pick<ModelServer, "resolveBinary" | "baseURL" | "headers">;
}
export class ModelCache {
  constructor(private readonly ports: Dependencies) {}
  owners = new Map<string, string>();
  contextEpochs = new Map<string, number>();
  transientSlots = new Set<string>();
  private snapshotDirectory(modelID: string) {
    const model = this.ports.main
      .config()
      .models.find((m) => m.modelID === modelID);
    if (!model?.slotSnapshots?.enabled)
      throw new NightcrewError(
        "runtime.snapshotsDisabled",
        "Enable slotSnapshots for this model first",
        3,
      );
    return path.join(
      model.slotSnapshots.directory ?? path.join(this.ports.main.home, "slots"),
      modelID,
    );
  }
  async privateDirectory(modelID: string) {
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
    const model = this.ports.main
      .config()
      .models.find((m) => m.modelID === modelID)!;
    const files = [];
    for (const file of [
      model.weightsPath,
      model.projectorPath,
      await this.ports.server.resolveBinary(),
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
          slots: this.ports.main
            .config()
            .slots.filter((s) => s.modelID === modelID),
        }),
      )
      .digest("hex");
  }
  async eraseSlot(slotID: string, signal: AbortSignal) {
    const slot = this.ports.main
      .config()
      .slots.find((s) => s.slotID === slotID);
    if (!slot) throw Error("Unknown slot");
    const response = await fetch(
      this.ports.server.baseURL +
        "/slots/" +
        slot.index +
        "?action=erase&model=" +
        encodeURIComponent(slot.modelID),
      {
        method: "POST",
        headers: this.ports.server.headers(),
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
  async slotAction(
    slotID: string,
    action: "save" | "restore",
    signal: AbortSignal,
    contextID = slotID,
    contextEpoch = 0,
  ) {
    const slot = this.ports.main
      .config()
      .slots.find((s) => s.slotID === slotID)!;
    const status = await fetch(
      this.ports.server.baseURL +
        "/slots?model=" +
        encodeURIComponent(slot.modelID),
      { headers: this.ports.server.headers(), signal },
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
      this.ports.server.baseURL +
        "/slots/" +
        slot.index +
        "?action=" +
        action +
        "&model=" +
        encodeURIComponent(slot.modelID),
      {
        method: "POST",
        headers: this.ports.server.headers(),
        body: JSON.stringify({ filename, model: slot.modelID }),
        signal,
      },
    );
    if (!res.ok) {
      if (action === "restore") {
        const reset = await fetch(
          this.ports.server.baseURL +
            "/slots/" +
            slot.index +
            "?action=erase&model=" +
            encodeURIComponent(slot.modelID),
          {
            method: "POST",
            headers: this.ports.server.headers(),
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
  async saveLoaded(cancel?: AbortSignal) {
    if (
      this.ports.main.config().scheduler.snapshotBudgetMB === 0 ||
      !this.ports.main.loadedModel ||
      !this.ports.main
        .config()
        .models.find((m) => m.modelID === this.ports.main.loadedModel)
        ?.slotSnapshots?.enabled
    )
      return;
    const timeout = AbortSignal.timeout(60000);
    const signal = cancel ? AbortSignal.any([timeout, cancel]) : timeout;
    for (const slot of this.ports.main
      .config()
      .slots.filter((s) => s.modelID === this.ports.main.loadedModel)) {
      if (signal.aborted) return;
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
        if (signal.aborted) return;
        this.ports.main.logger?.emit("slot.snapshotSaveFailed", {
          slotID: slot.slotID,
          reason: "transport",
        });
      }
    }
  }
  async snapshot(slotID: string, action: "save" | "restore", dryRun = false) {
    if (this.ports.main.busy || this.ports.main.used.size)
      throw new NightcrewError(
        "runtime.busy",
        "Inference or another slot operation is active",
        9,
      );
    const slot = this.ports.main
      .config()
      .slots.find((s) => s.slotID === slotID);
    if (!slot)
      throw new NightcrewError("resource.notFound", "Slot not found", 7);
    const directory = this.snapshotDirectory(slot.modelID);
    if (dryRun) return { slotID, action, changed: false, directory };
    this.ports.main.busy = true;
    clearTimeout(this.ports.main.idleTimer);
    try {
      const signal = executionSignal() ?? AbortSignal.timeout(90000);
      if (action === "save" && this.ports.main.loadedModel !== slot.modelID)
        throw new NightcrewError(
          "runtime.modelUnloaded",
          "Cannot save an unloaded model",
          9,
        );
      if (action === "restore")
        await this.ports.main.prepare(slot.modelID, signal, false);
      await this.slotAction(slotID, action, signal);
      return { slotID, action, changed: true, directory };
    } finally {
      this.ports.main.busy = false;
      this.ports.main.scheduleIdle(slot.modelID);
    }
  }
  async contextCache(contextID: string, reset: boolean, dryRun = false) {
    if (!/^[a-zA-Z0-9_-]+$/.test(contextID))
      throw Error("Invalid context identity");
    if (reset && (this.ports.main.busy || this.ports.main.used.size))
      throw new NightcrewError(
        "runtime.busy",
        "Wait for inference to settle before resetting caches",
        9,
      );
    if (reset) this.ports.main.busy = true;
    try {
      const items = [];
      for (const model of this.ports.main
        .config()
        .models.filter((m) => m.slotSnapshots.enabled)) {
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
      if (reset) {
        this.ports.main.busy = false;
        if (this.ports.main.loadedModel)
          this.ports.main.scheduleIdle(this.ports.main.loadedModel);
      }
    }
  }
  async pruneSnapshots(signal?: AbortSignal) {
    signal?.throwIfAborted();
    const caches: {
      manifest: string;
      file: string;
      bytes: number;
      mtime: number;
    }[] = [];
    for (const model of this.ports.main
      .config()
      .models.filter((m) => m.slotSnapshots.enabled)) {
      signal?.throwIfAborted();
      const directory = await this.privateDirectory(model.modelID);
      for (const name of await readdir(directory)) {
        signal?.throwIfAborted();
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
      signal?.throwIfAborted();
      if (
        bytes <=
        this.ports.main.config().scheduler.snapshotBudgetMB * 1024 * 1024
      )
        break;
      await unlink(cache.manifest);
      await unlink(cache.file).catch(() => {});
      bytes -= cache.bytes;
    }
  }
}
