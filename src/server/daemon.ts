import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import path from "node:path";
import { z } from "zod";
import { type ManagementInput } from "../commands/management.js";
import { callOperation } from "../commands/operations.js";
import {
  Execution,
  checkpoint,
  currentExecution,
  executionSignal,
  remainingTimeout,
} from "../engine/execution/process.js";
import {
  NightcrewError,
  errorSchema,
  normalizeError,
  timeoutFailure,
} from "../engine/protocol.js";
import { startServer } from "./http.js";

const controlSchema = z.strictObject({
  command: z.string(),
  resourceID: z.string().optional(),
  request: z.unknown().optional(),
  dryRun: z.boolean().optional(),
  yes: z.boolean().optional(),
  timeoutMs: z.number().int().min(1).max(300000).optional(),
});
const socketPath = (home: string) => {
  const file = path.join(home, "control.sock");
  if (Buffer.byteLength(file) > 100)
    throw new NightcrewError(
      "config.socketPathTooLong",
      "Runtime home is too long for a local control socket; choose a shorter --home",
      3,
    );
  return file;
};
export async function control(
  home: string,
  input: ManagementInput,
  timeoutMs = 90000,
): Promise<unknown> {
  checkpoint();
  const file = socketPath(home);
  try {
    const stat = await lstat(file);
    if (
      !stat.isSocket() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new NightcrewError(
        "config.invalidControlSocket",
        "Control socket must be owned by the current user and private",
        3,
      );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw Object.assign(Error("Daemon unavailable"), { code: "OFFLINE" });
    throw e;
  }
  return new Promise((resolve, reject) => {
    let output = "",
      connected = false;
    const socket = createConnection(file);
    const mutation = currentExecution()?.mutation ?? false;
    const aborted = () => socket.destroy(timeoutFailure(mutation && connected));
    const timer = setTimeout(aborted, remainingTimeout(timeoutMs));
    const signal = executionSignal();
    signal?.addEventListener("abort", aborted, { once: true });
    socket.once("close", () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    });
    socket.on("connect", () => {
      connected = true;
      try {
        socket.write(
          JSON.stringify({ ...input, timeoutMs: remainingTimeout(timeoutMs) }) +
            "\n",
        );
      } catch (error) {
        socket.destroy(normalizeError(error, mutation));
      }
    });
    socket.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8");
      if (Buffer.byteLength(output) > 64 * 1024 * 1024)
        socket.destroy(Error("Response limit"));
      if (output.includes("\n")) {
        socket.end();
        try {
          const data = JSON.parse(output.split("\n")[0]!);
          if (!data.ok) {
            const error = errorSchema.parse(data.error);
            reject(
              new NightcrewError(
                error.code,
                error.message,
                error.exitCode,
                error.retrySafety,
                error.details,
              ),
            );
          } else resolve(data.result);
        } catch {
          reject(
            new NightcrewError(
              "daemon.invalidResponse",
              "Daemon response is incompatible; restart the daemon after upgrading",
              5,
              mutation ? "unsafe" : "safe",
              { outcomeUnknown: mutation },
            ),
          );
        }
      }
    });
    socket.on("error", (e: NodeJS.ErrnoException) =>
      reject(
        !connected && e.code === "ECONNREFUSED"
          ? Object.assign(Error("Daemon unavailable"), { code: "OFFLINE" })
          : e,
      ),
    );
    socket.on("end", () => {
      if (!output.includes("\n"))
        reject(
          new NightcrewError(
            "daemon.disconnected",
            "Daemon disconnected before returning a result",
            5,
            mutation ? "unsafe" : "safe",
            { outcomeUnknown: mutation },
          ),
        );
    });
  });
}
export async function runDaemon(home: string, quiet = false) {
  process.umask(0o077);
  const app = await startServer({ home, quiet });
  const file = socketPath(home);
  try {
    await unlink(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      await app.close();
      throw e;
    }
  }
  let closing = false;
  let release!: () => void;
  const done = new Promise<void>((resolve) => (release = resolve));
  const sockets = new Set<import("node:net").Socket>();
  const pending = new Set<Promise<void>>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.setTimeout(30000, () => socket.destroy());
    let buffer = "";
    let accepted = false;
    socket.on("data", (chunk: Buffer) => {
      if (accepted) return;
      buffer += chunk.toString("utf8");
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        socket.destroy();
        return;
      }
      if (!buffer.includes("\n")) return;
      accepted = true;
      const work = (async () => {
        let mutation = false;
        try {
          if (closing) throw Error("Daemon stopping");
          const input = controlSchema.parse(JSON.parse(buffer.split("\n")[0]!));
          const { getCommand } = await import("../commands/registry.js");
          const definition =
            getCommand(input.command) ??
            (["evals sample", "evals release"].includes(input.command)
              ? (await import("../commands/operations.js")).getOperation(
                  input.command,
                )
              : undefined);
          if (
            !definition ||
            !["management", "daemon"].includes(definition.scope)
          )
            throw new NightcrewError(
              "cli.invalidCommand",
              "Command is not available on the control socket",
              2,
            );
          mutation = definition.mutates && !input.dryRun;
          socket.setTimeout(0);
          if (input.command === "daemon stop") {
            socket.end(
              JSON.stringify({
                ok: true,
                result: { stopping: true, pid: process.pid },
              }) + "\n",
            );
            if (!input.dryRun)
              setTimeout(() => {
                void stop();
              }, 20);
            return;
          }
          const execution = new Execution(input.timeoutMs ?? 90000, mutation);
          const result = await execution.run(async () => {
            input.request = definition.request.parse(input.request ?? {});
            const output = await callOperation(app.service, input);
            try {
              return definition.result.parse(output);
            } catch {
              throw new NightcrewError(
                "protocol.invalidResult",
                "Command returned an invalid result",
                1,
                mutation ? "unsafe" : "safe",
                { outcomeUnknown: mutation },
              );
            }
          });
          socket.end(JSON.stringify({ ok: true, result }) + "\n");
        } catch (e) {
          socket.end(
            JSON.stringify({
              ok: false,
              error: normalizeError(e, mutation).toJSON(),
            }) + "\n",
          );
        }
      })();
      pending.add(work);
      void work.finally(() => pending.delete(work));
    });
  });
  const stop = async () => {
    if (closing) return;
    closing = true;
    server.close();
    await Promise.all(pending);
    for (const socket of sockets) socket.destroy();
    await app.close();
    await unlink(file).catch(() => {});
    process.removeListener("SIGTERM", signal);
    process.removeListener("SIGINT", signal);
    app.logger.emit("daemon.stopped");
    await app.logger.flush();
    release();
  };
  const signal = () => {
    void stop().catch(async () => {
      app.logger.emit("daemon.stopFailed");
      await app.logger.flush();
      process.exitCode = 1;
      release();
    });
  };
  process.on("SIGTERM", signal);
  process.on("SIGINT", signal);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(file, resolve);
    });
    await chmod(file, 0o600);
    app.logger.emit("daemon.ready", { pid: process.pid });
    await done;
  } catch (e) {
    await stop();
    throw e;
  }
}
