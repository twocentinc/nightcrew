import path from "node:path";
import { z } from "zod";
import {
  checkpoint,
  diagnostic,
  pause,
  remainingTimeout,
} from "../engine/execution/process.js";
import { LlamaRuntime } from "../engine/models/runtime.js";
import { storeSchema } from "../schemas/config.js";
import { startup, startupLogs, startupStatus } from "../server/startup.js";
import { readJSON } from "../storage/files.js";
import type { Define } from "../utils/commands/registry.js";

const control: typeof import("../server/daemon.js").control = async (...args) =>
  (await import("../server/daemon.js")).control(...args);
const runDaemon: typeof import("../server/daemon.js").runDaemon = async (
  ...args
) => (await import("../server/daemon.js")).runDaemon(...args);

export const operationInputs = {};

export const operations = {};
const serviceStatus = z.object({
  label: z.string(),
  plistPath: z.string(),
  configured: z.boolean(),
  loaded: z.boolean(),
  running: z.boolean(),
  pid: z.number().nullable(),
  state: z.string().nullable(),
  lastExitStatus: z.string().nullable(),
});
const startupResult = z.union([
  serviceStatus.extend({ changed: z.boolean() }),
  z.object({
    changed: z.literal(false),
    action: z.string(),
    label: z.string(),
    plistPath: z.string(),
    plist: z.string().optional(),
  }),
]);

export function registerLocal(define: Define) {
  define(
    "daemon run",
    "Run the daemon in the foreground",
    "local",
    "none",
    true,
    z.object({ changed: z.literal(false), home: z.string() }),
    async (c) => {
      if (c.dryRun) return { changed: false, home: c.home };
      await runDaemon(
        c.home,
        !!c.values.quiet || c.values.verbosity === "quiet",
      );
      return undefined;
    },
  );
  define(
    "daemon stop",
    "Gracefully stop the selected daemon",
    "daemon",
    "none",
    true,
    z.union([
      startupResult,
      z.object({ stopped: z.boolean(), pid: z.number() }),
      z.object({ stopping: z.boolean(), pid: z.number() }),
    ]),
    async (c) => {
      if (process.platform === "darwin") {
        const status = await startupStatus();
        if (status.loaded)
          return startup("stop", c.home, {
            dryRun: c.dryRun,
            yes: c.yes,
            timeoutMs: remainingTimeout(90000),
          });
      }
      const result = (await control(
        c.home,
        { command: "daemon stop", dryRun: c.dryRun },
        remainingTimeout(90000),
      )) as { pid: number; stopping: boolean };
      if (c.dryRun) return result;
      while (true) {
        checkpoint();
        try {
          process.kill(result.pid, 0);
        } catch {
          return { stopped: true, pid: result.pid };
        }
        await pause(100);
      }
    },
  );
  for (const action of [
    "install",
    "uninstall",
    "status",
    "start",
    "restart",
    "logs",
  ]) {
    const name = "daemon " + action;
    const mutation = !["status", "logs"].includes(action);
    const result =
      action === "status"
        ? serviceStatus
        : action === "logs"
          ? z.object({
              nextCursor: z.string().nullable(),
              files: z.array(
                z.object({
                  path: z.string(),
                  lines: z.array(z.string()),
                  truncated: z.boolean(),
                }),
              ),
            })
          : startupResult;
    define(
      name,
      `${action} the per-user LaunchAgent`,
      "local",
      "none",
      mutation,
      result,
      async (c) => {
        if (action === "logs")
          return startupLogs(
            c.home,
            Number(c.values.lines ?? 100),
            Number(c.values.limit ?? 100),
            c.values.cursor as string | undefined,
          );
        if (["install", "start", "restart"].includes(action)) {
          const state = await readJSON(
            path.join(c.home, "config.json"),
            storeSchema,
            8 * 1024 * 1024,
          );
          if (!c.dryRun)
            await new LlamaRuntime(() => state.config).initialize();
        }
        let result = await startup(action, c.home, {
          dryRun: c.dryRun,
          yes: c.yes,
          timeoutMs: remainingTimeout(90000),
        });
        if (!c.dryRun && ["install", "start", "restart"].includes(action)) {
          while (true) {
            checkpoint();
            try {
              await control(
                c.home,
                { command: "status" },
                remainingTimeout(1000),
              );
              break;
            } catch (e) {
              checkpoint();
              diagnostic("debug", "daemon.waitingForReadiness");
            }
            await pause(200);
          }
          result = { ...result, ...(await startupStatus()) };
        }
        return result;
      },
      {
        confirmation: action === "uninstall",
        options: action === "logs" ? ["lines", "limit", "cursor", "tail"] : [],
      },
    );
  }
}
