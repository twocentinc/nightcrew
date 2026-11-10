import { mkdir, lstat, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const loggingSchema = z.strictObject({
  level: z.enum(["off", "error", "warn", "info", "debug"]).default("warn"),
  maxBytes: z
    .number()
    .int()
    .min(1024)
    .max(16 * 1024 * 1024)
    .default(1024 * 1024),
  files: z.number().int().min(1).max(10).default(3),
});
export type LoggingConfig = z.infer<typeof loggingSchema>;
// An explicit event/field allowlist prevents accidental transcript or secret logging.
const events = {
  "scheduler.hookFailed": "warn",
  "trigger.dispatchFailed": "warn",
  "daemon.ready": "info",
  "daemon.stopped": "info",
  "daemon.stopFailed": "error",
  "runtime.unexpectedExit": "error",
  "storage.writeFailed": "error",
  "slot.snapshotSaveFailed": "warn",
  "slot.snapshotRestoreFailed": "warn",
  "presence.unhealthy": "warn",
  "presence.recovered": "info",
  "runtime.modelSwitched": "info",
  "runtime.ready": "debug",
} as const;
export type LogEvent = keyof typeof events;
const fields = z.object({
  pid: z.number().int().positive().optional(),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  modelID: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    .optional(),
  slotID: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/)
    .optional(),
  reason: z
    .enum([
      "io",
      "permissions",
      "space",
      "invalid_cache",
      "transport",
      "process",
      "sampling",
    ])
    .optional(),
});
type Fields = z.infer<typeof fields>;
const ranks = { off: 0, error: 1, warn: 2, info: 3, debug: 4 };
export class OperationalLog {
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private warned = false;
  private recent = new Map<string, { at: number; suppressed: number }>();
  constructor(
    readonly home: string,
    private settings: () => LoggingConfig,
    private quiet = false,
  ) {}
  emit(event: LogEvent, details: Fields = {}) {
    if (!Object.hasOwn(events, event)) return;
    const settings = this.settings();
    if (
      this.quiet ||
      settings.level === "off" ||
      ranks[events[event]] > ranks[settings.level]
    )
      return;
    const parsed = fields.safeParse(details);
    if (!parsed.success) return;
    const key = event + ":" + (parsed.data.modelID ?? parsed.data.slotID ?? "");
    const now = Date.now();
    const previous = this.recent.get(key);
    if (previous && now - previous.at < 30000) {
      previous.suppressed++;
      return;
    }
    if (this.pending >= 128) return;
    if (this.recent.size >= 256 && !previous)
      this.recent.delete(this.recent.keys().next().value!);
    this.recent.set(key, { at: now, suppressed: 0 });
    const entry = {
      at: new Date(now).toISOString(),
      level: events[event],
      event,
      ...parsed.data,
      ...(previous?.suppressed ? { suppressed: previous.suppressed } : {}),
    };
    this.pending++;
    this.tail = this.tail
      .then(async () => {
        // Turning logging off also discards work that has not reached disk yet.
        const current = this.settings();
        if (
          current.level === "off" ||
          ranks[events[event]] > ranks[current.level]
        )
          return;
        await this.append(JSON.stringify(entry) + "\n", current);
      })
      .catch(() => {
        if (!this.warned && this.settings().level !== "off") {
          this.warned = true;
          process.stderr.write(
            '{"level":"error","event":"logging.unavailable"}\n',
          );
        }
      })
      .finally(() => {
        this.pending--;
      });
  }
  async flush() {
    await this.tail;
  }
  private async regular(file: string) {
    try {
      const s = await lstat(file);
      if (
        !s.isFile() ||
        s.isSymbolicLink() ||
        s.uid !== process.getuid?.() ||
        (s.mode & 0o077) !== 0
      )
        throw Error("Unsafe log file");
      return s;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  private async append(line: string, settings: LoggingConfig) {
    const directory = path.join(this.home, "logs");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const dir = await lstat(directory);
    if (
      !dir.isDirectory() ||
      dir.isSymbolicLink() ||
      dir.uid !== process.getuid?.() ||
      (dir.mode & 0o077) !== 0
    )
      throw Error("Unsafe log directory");
    const file = path.join(directory, "daemon.jsonl");
    const bytes = Buffer.byteLength(line);
    if (bytes > settings.maxBytes) return;
    for (let i = settings.files; i < 10; i++) {
      const old = file + "." + i;
      if (await this.regular(old)) await unlink(old);
    }
    const current = await this.regular(file);
    if (current && current.size + bytes > settings.maxBytes) {
      for (let i = settings.files - 1; i >= 1; i--) {
        const target = file + "." + i;
        if (await this.regular(target)) await unlink(target);
        const source = i === 1 ? file : file + "." + (i - 1);
        if (await this.regular(source)) await rename(source, target);
      }
      if (settings.files === 1) await unlink(file);
    }
    // Enforce a lowered size limit on old rotations too.
    for (let i = 1; i < settings.files; i++) {
      const old = file + "." + i;
      const info = await this.regular(old);
      if (info && info.size > settings.maxBytes) await unlink(old);
    }
    const handle = await open(
      file,
      constants.O_WRONLY |
        constants.O_APPEND |
        constants.O_CREAT |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await handle.writeFile(line);
    } finally {
      await handle.close();
    }
  }
}
