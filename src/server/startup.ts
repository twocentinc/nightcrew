import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  checkpoint,
  executionSignal,
  pause,
  remainingTimeout,
} from "../engine/execution/process.js";
import {
  NightcrewError,
  invalidInput,
  timeoutFailure,
} from "../engine/protocol.js";

export const label = "dev.nightcrew.daemon";
export const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
export const cliFile = path.join(projectRoot, "dist", "cli.js");
export const plistPath = path.join(
  homedir(),
  "Library",
  "LaunchAgents",
  label + ".plist",
);
const exec = promisify(execFile);
const escape = (s: string) =>
  s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
export function renderPlist(home: string) {
  const executablePath = [
    path.dirname(process.execPath),
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter((p) => path.isAbsolute(p));
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(cliFile)}</string><string>daemon</string><string>run</string><string>--home</string><string>${escape(home)}</string></array>
<key>WorkingDirectory</key><string>${escape(projectRoot)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${escape([...new Set(executablePath)].join(path.delimiter))}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ProcessType</key><string>Standard</string><key>ThrottleInterval</key><integer>30</integer><key>Umask</key><integer>63</integer>
<key>ExitTimeOut</key><integer>75</integer>
<key>StandardOutPath</key><string>${escape(path.join(home, "logs", "launchd.stdout.log"))}</string>
<key>StandardErrorPath</key><string>${escape(path.join(home, "logs", "launchd.stderr.log"))}</string>
</dict></plist>\n`;
}
export type Runner = (
  args: string[],
) => Promise<{ code: number; stdout: string }>;
export const launchctl: Runner = async (args) => {
  try {
    const { stdout } = await exec("/bin/launchctl", args, {
      timeout: remainingTimeout(10000),
      signal: executionSignal(),
      maxBuffer: 1024 * 1024,
    });
    return { code: 0, stdout };
  } catch (e) {
    const error = e as Error & { code?: number | string; stdout?: string };
    if (typeof error.code !== "number") {
      checkpoint();
      throw new NightcrewError(
        "startup.launchctlUnavailable",
        "launchctl unavailable",
        5,
      );
    }
    return { code: error.code, stdout: error.stdout ?? "" };
  }
};
function uid() {
  if (process.platform !== "darwin" || !process.getuid?.())
    throw new NightcrewError(
      "startup.unsupportedHost",
      "LaunchAgent management requires a non-root macOS user",
      4,
    );
  return process.getuid();
}
async function installed() {
  try {
    const stat = await lstat(plistPath);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.()
    )
      throw Error("Invalid LaunchAgent file");
    return await readFile(plistPath, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}
export async function startupStatus(runner = launchctl) {
  const configured = await installed();
  const result = await runner(["print", `gui/${uid()}/${label}`]);
  return {
    label,
    plistPath,
    configured: configured !== null,
    loaded: result.code === 0,
    running: result.code === 0 && /^\s*pid\s*=\s*\d+/m.test(result.stdout),
    pid:
      result.code === 0
        ? Number(/^\s*pid\s*=\s*(\d+)/m.exec(result.stdout)?.[1]) || null
        : null,
    state: /^\s*state\s*=\s*(.+)$/m.exec(result.stdout)?.[1]?.trim() ?? null,
    lastExitStatus:
      /^\s*last exit code\s*=\s*(-?\d+)/m.exec(result.stdout)?.[1] ?? null,
  };
}
export async function startup(
  action: string,
  home: string,
  options: { dryRun?: boolean; yes?: boolean; timeoutMs: number },
  runner = launchctl,
) {
  const target = `gui/${uid()}/${label}`;
  const old = await installed();
  const expected = renderPlist(home);
  if (old && !old.includes(`<string>${escape(home)}</string>`))
    throw new NightcrewError(
      "startup.conflict",
      "LaunchAgent belongs to another runtime home",
      9,
    );
  if (action === "status") return startupStatus(runner);
  const before = await startupStatus(runner);
  if (!old && before.loaded)
    throw Error(
      "Conflicting loaded LaunchAgent without the expected registration",
    );
  if (options.dryRun)
    return {
      changed: false,
      action,
      label,
      plistPath,
      ...(action === "install" ? { plist: expected } : {}),
    };
  const required = async (args: string[]) => {
    checkpoint();
    const r = await runner(args);
    if (r.code !== 0)
      throw new NightcrewError(
        "startup.launchctlFailed",
        "launchctl operation failed",
        5,
        "unsafe",
        { operation: args[0]!, outcomeUnknown: true },
      );
  };
  const stop = async () => {
    const status = await startupStatus(runner);
    if (!status.loaded) return;
    await required(["bootout", target]);
    const deadline = Date.now() + remainingTimeout(options.timeoutMs);
    while (Date.now() < deadline) {
      const current = await startupStatus(runner);
      let alive = false;
      if (status.pid)
        try {
          process.kill(status.pid, 0);
          alive = true;
        } catch {}
      if (!current.loaded && !alive) return;
      await pause(200);
    }
    throw timeoutFailure(true);
  };
  if (action === "install") {
    if (old && old !== expected)
      throw Error(
        "Conflicting registration; uninstall explicitly before replacing",
      );
    await mkdir(path.join(home, "logs"), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(plistPath), { recursive: true });
    if (!old) {
      const temp = plistPath + "." + randomUUID() + ".tmp";
      await writeFile(temp, expected, { flag: "wx", mode: 0o600 });
      await exec("/usr/bin/plutil", ["-lint", temp], {
        timeout: remainingTimeout(10000),
        signal: executionSignal(),
      });
      checkpoint();
      await rename(temp, plistPath);
    }
    const status = await startupStatus(runner);
    if (!status.loaded) {
      await required(["enable", target]);
      await required(["bootstrap", `gui/${uid()}`, plistPath]);
    }
  } else if (action === "stop") {
    await stop();
  } else if (action === "uninstall") {
    if (!options.yes)
      throw new NightcrewError(
        "cli.confirmationRequired",
        "Uninstall requires --yes",
        8,
      );
    await stop();
    if (old) await unlink(plistPath);
  } else if (action === "start" || action === "restart") {
    if (!old)
      throw new NightcrewError(
        "startup.notInstalled",
        "Run startup install first",
        7,
      );
    if (action === "restart") await stop();
    const status = await startupStatus(runner);
    if (!status.loaded) {
      await required(["enable", target]);
      await required(["bootstrap", `gui/${uid()}`, plistPath]);
    } else if (!status.running) await required(["kickstart", target]);
  } else throw Error("Unknown startup command");
  const changed =
    action === "install"
      ? !old || !before.loaded
      : action === "stop"
        ? before.loaded
        : action === "uninstall"
          ? !!old || before.loaded
          : action === "start"
            ? !before.running
            : true;
  return { changed, ...(await startupStatus(runner)) };
}
export async function startupLogs(
  home: string,
  lines: number,
  limit = 100,
  cursor?: string,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw invalidInput("limit must be 1..100");
  if (!Number.isInteger(lines) || lines < 1 || lines > 10000)
    throw invalidInput("lines must be 1..10000");
  const files = [];
  for (const name of [
    "daemon.jsonl",
    ...Array.from({ length: 9 }, (_, i) => "daemon.jsonl." + (i + 1)),
    "launchd.stdout.log",
    "launchd.stderr.log",
  ]) {
    checkpoint();
    const file = path.join(home, "logs", name);
    let contents = "";
    let truncated = false;
    try {
      const stat = await lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("Invalid log file");
      const handle = await open(file, "r");
      try {
        const bytes = Math.min(stat.size, 1024 * 1024);
        const data = Buffer.alloc(bytes);
        await handle.read(data, 0, bytes, stat.size - bytes);
        contents = data.toString("utf8");
        truncated = stat.size > bytes;
      } finally {
        await handle.close();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (name.startsWith("daemon.jsonl")) continue;
    }
    files.push({
      path: file,
      lines: contents
        ? contents
            .trimEnd()
            .split(/\r?\n/)
            .slice(truncated ? 1 : 0)
            .slice(-lines)
        : [],
      truncated,
    });
  }
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ home, lines, limit, files }))
    .digest("hex");
  let offset = 0;
  if (cursor) {
    if (cursor.length > 512) throw invalidInput("Invalid log cursor");
    let value: { fingerprint: string; offset: number };
    try {
      value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    } catch {
      throw invalidInput("Invalid log cursor");
    }
    if (
      !value ||
      !Number.isSafeInteger(value.offset) ||
      value.offset < 1 ||
      typeof value.fingerprint !== "string"
    )
      throw invalidInput("Invalid log cursor");
    if (value.fingerprint !== fingerprint)
      throw new NightcrewError(
        "resource.cursorExpired",
        "Logs or query changed; restart pagination without a cursor",
        9,
        "safe",
      );
    offset = value.offset;
  }
  const entries = files.flatMap((file) =>
    file.lines.map((line) => ({
      path: file.path,
      line,
      truncated: file.truncated,
    })),
  );
  if (offset > entries.length) throw invalidInput("Invalid log cursor offset");
  const page = entries.slice(offset, offset + limit);
  const grouped: typeof files = [];
  for (const entry of page) {
    let file = grouped.at(-1);
    if (file?.path !== entry.path) {
      file = { path: entry.path, lines: [], truncated: entry.truncated };
      grouped.push(file);
    }
    file!.lines.push(entry.line);
  }
  const nextCursor =
    offset + limit < entries.length
      ? Buffer.from(
          JSON.stringify({ fingerprint, offset: offset + limit }),
        ).toString("base64url")
      : null;
  return { files: grouped, nextCursor };
}

// Follow active files by byte offset, retaining partial UTF-8 lines and draining
// an open inode before switching to its replacement after log rotation.
export async function* tailLogs(home: string, lines = 100) {
  type OpenLog = {
    handle: Awaited<ReturnType<typeof open>>;
    inode: number;
    offset: number;
    pending: Buffer;
  };
  const files = new Map<string, OpenLog>();
  const seen = new Set<string>();
  const paths = [
    "daemon.jsonl",
    "launchd.stdout.log",
    "launchd.stderr.log",
  ].map((name) => path.join(home, "logs", name));
  const read = async (
    file: string,
    state: OpenLog,
    initial = false,
    skipFragment = false,
  ) => {
    const stat = await state.handle.stat();
    if (stat.size < state.offset) {
      state.offset = 0;
      state.pending = Buffer.alloc(0);
    }
    const output: string[] = [];
    while (state.offset < stat.size) {
      checkpoint();
      const bytes = Buffer.alloc(
        Math.min(1024 * 1024, stat.size - state.offset),
      );
      const { bytesRead } = await state.handle.read(
        bytes,
        0,
        bytes.length,
        state.offset,
      );
      if (!bytesRead) break;
      state.offset += bytesRead;
      const data = Buffer.concat([state.pending, bytes.subarray(0, bytesRead)]);
      const end = data.lastIndexOf(10);
      if (end >= 0)
        output.push(...data.subarray(0, end).toString("utf8").split(/\r?\n/));
      state.pending = data.subarray(end + 1);
      if (state.pending.length > 1024 * 1024)
        throw invalidInput("Log line exceeds 1 MB");
    }
    if (skipFragment) output.shift();
    return {
      path: file,
      lines: initial ? output.slice(-lines) : output,
      truncated: skipFragment,
    };
  };
  try {
    while (true) {
      for (const file of paths) {
        checkpoint();
        let stat;
        try {
          stat = await lstat(file);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw e;
        }
        if (!stat.isFile() || stat.isSymbolicLink())
          throw invalidInput("Invalid log file");
        let state = files.get(file);
        if (state && state.inode !== stat.ino) {
          const old = await read(file, state);
          if (old.lines.length) yield { files: [old], nextCursor: null };
          await state.handle.close();
          files.delete(file);
          state = undefined;
        }
        const initial = !state;
        if (!state) {
          const handle = await open(file, "r");
          const opened = await handle.stat();
          // Only the first observation skips old content; replacements start at zero.
          const offset = seen.has(file)
            ? 0
            : Math.max(0, opened.size - 1024 * 1024);
          state = {
            handle,
            inode: opened.ino,
            offset,
            pending: Buffer.alloc(0),
          };
          files.set(file, state);
          const entry = await read(file, state, !seen.has(file), offset > 0);
          seen.add(file);
          if (entry.lines.length) yield { files: [entry], nextCursor: null };
        }
        if (!initial) {
          const entry = await read(file, state);
          if (entry.lines.length) yield { files: [entry], nextCursor: null };
        }
      }
      await pause(250);
    }
  } finally {
    await Promise.all([...files.values()].map((file) => file.handle.close()));
  }
}
