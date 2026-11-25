import { AsyncLocalStorage } from "node:async_hooks";
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { invalidInput, timeoutFailure } from "../protocol.js";

export type Verbosity = "quiet" | "normal" | "verbose" | "debug";
export class Execution {
  readonly started = performance.now();
  readonly controller = new AbortController();
  constructor(
    readonly timeoutMs: number,
    readonly mutation = false,
    readonly verbosity: Verbosity = "normal",
  ) {}
  get signal() {
    return this.controller.signal;
  }
  remaining() {
    return Math.max(0, this.timeoutMs - (performance.now() - this.started));
  }
  check() {
    if (this.remaining() <= 0 && !this.signal.aborted)
      this.controller.abort(timeoutFailure(this.mutation));
    if (this.signal.aborted) throw this.signal.reason;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    this.check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await context.run(this, () =>
        Promise.race([
          Promise.resolve().then(fn),
          new Promise<never>((_, reject) => {
            if (!Number.isFinite(this.timeoutMs)) {
              this.signal.addEventListener(
                "abort",
                () => reject(this.signal.reason),
                { once: true },
              );
              return;
            }
            timer = setTimeout(() => {
              const error = timeoutFailure(this.mutation);
              this.controller.abort(error);
              reject(error);
            }, this.remaining());
          }),
        ]),
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
const context = new AsyncLocalStorage<Execution | undefined>();
export const currentExecution = () => context.getStore();
export const checkpoint = () => context.getStore()?.check();
export const remainingTimeout = (fallback: number) => {
  checkpoint();
  return Math.max(
    1,
    Math.ceil(Math.min(fallback, context.getStore()?.remaining() ?? fallback)),
  );
};
export const executionSignal = () => context.getStore()?.signal;
export async function pause(ms: number) {
  checkpoint();
  await delay(Math.min(ms, remainingTimeout(ms)), undefined, {
    signal: executionSignal(),
  });
  checkpoint();
}
export function parseDuration(value: string, maximumMs = 300000) {
  const match = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(value);
  if (!match) throw invalidInput("Timeout requires ms, s, or m");
  const result =
    Number(match[1]) * ({ ms: 1, s: 1000, m: 60000 }[match[2]!] ?? 0);
  if (!Number.isSafeInteger(result) || result < 1 || result > maximumMs)
    throw invalidInput(`Timeout must be 1ms..${maximumMs / 60000}m`);
  return result;
}
export function diagnostic(
  level: "verbose" | "debug" | "warning",
  event: string,
  details: Record<string, string | number | boolean> = {},
) {
  const verbosity = context.getStore()?.verbosity ?? "normal";
  if (
    verbosity === "quiet" ||
    (level === "debug" && verbosity !== "debug") ||
    (level === "verbose" && !["verbose", "debug"].includes(verbosity))
  )
    return;
  process.stderr.write(JSON.stringify({ level, event, ...details }) + "\n");
}

export const withoutExecution = <T>(fn: () => T): T =>
  context.run(undefined, fn);

// The extra pipe (fd 3) is owned only by Nightcrew. EOF also happens on SIGKILL,
// unlike JS cleanup handlers. The guard and executable share a detached process
// group so loss of the owner terminates descendants, including llama workers.
export const ownedProcessGuard = `
const {spawn} = require('node:child_process');
const {Socket} = require('node:net');
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  setTimeout(() => { try { process.kill(-process.pid, 'SIGKILL'); } catch {} }, 500);
  try { process.kill(-process.pid, 'SIGTERM'); } catch {}
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
const ownerFD = Number(process.env.NIGHTCREW_OWNER_FD ?? 3);
const owner = new Socket({fd:ownerFD, readable:true, writable:false});
owner.on('end', stop);
owner.on('error', stop);
owner.resume();
const env = {...process.env}; delete env.NIGHTCREW_OWNER_FD;
const child = spawn(process.argv[1], process.argv.slice(2), {env, stdio:['pipe','inherit','inherit', ...Array(ownerFD - 3).fill('inherit')]});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.on('error', () => process.exit(127));
child.on('exit', (code) => { if (!stopping) process.exit(code ?? 1); });
`;

export function spawnOwned(
  executable: string,
  argv: string[],
  options: {
    env: NodeJS.ProcessEnv;
    stdin?: "pipe" | "ignore";
    stdout?: "pipe" | "ignore";
    extraInputs?: string[];
  },
): ChildProcess {
  const extras = options.extraInputs ?? [];
  const child = spawn(
    process.execPath,
    ["-e", ownedProcessGuard, executable, ...argv],
    {
      detached: true,
      env: { ...options.env, NIGHTCREW_OWNER_FD: String(3 + extras.length) },
      stdio: [
        options.stdin ?? "pipe",
        options.stdout ?? "pipe",
        "ignore",
        ...extras.map(() => "pipe" as const),
        "pipe",
      ],
    },
  );
  extras.forEach((input, index) => {
    const pipe = child.stdio[index + 3] as import("node:stream").Writable;
    pipe.on("error", () => {});
    pipe.end(input);
  });
  return child;
}

export async function runExecutable(options: {
  executable: string;
  argv?: string[];
  env: NodeJS.ProcessEnv;
  input: string;
  timeoutMs: number;
  signal?: AbortSignal;
  extraInputs?: string[];
  discardOutput?: boolean;
  errors: {
    timeout: string;
    interrupted: string;
    limit: string;
    failed:
      | string
      | ((code: number | null, signal: NodeJS.Signals | null) => string);
  };
}): Promise<Buffer> {
  options.signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawnOwned(options.executable, options.argv ?? [], {
      env: options.env,
      extraInputs: options.extraInputs,
      stdout: options.discardOutput ? "ignore" : "pipe",
    });
    const chunks: Buffer[] = [];
    let bytes = 0,
      failure: Error | undefined;
    const kill = () => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    const stop = (message: string) => {
      failure ??= Error(message);
      kill();
    };
    const abort = () => stop(options.errors.interrupted);
    const timer = setTimeout(
      () => stop(options.errors.timeout),
      options.timeoutMs,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout?.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1048576) stop(options.errors.limit);
      else chunks.push(chunk);
    });
    child.stdin!.on("error", () => {});
    child.once("error", (error) => {
      failure ??= error;
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      kill();
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          Error(
            typeof options.errors.failed === "function"
              ? options.errors.failed(code, signal)
              : options.errors.failed,
          ),
        );
      else resolve(Buffer.concat(chunks));
    });
    child.stdin!.end(options.input);
  });
}
