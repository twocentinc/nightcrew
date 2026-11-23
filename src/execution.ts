import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { invalidInput, timeoutFailure } from "./protocol.js";
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
              this.signal.addEventListener("abort", () => reject(this.signal.reason), {once: true});
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
const owner = new Socket({fd:3, readable:true, writable:false});
owner.on('end', stop);
owner.on('error', stop);
owner.resume();
const child = spawn(process.argv[1], process.argv.slice(2), {stdio:['pipe','inherit','inherit']});
process.stdin.pipe(child.stdin);
child.stdin.on('error', () => {});
child.on('error', () => process.exit(127));
child.on('exit', (code) => { if (!stopping) process.exit(code ?? 1); });
`;
