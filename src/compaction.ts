import { spawn } from "node:child_process";
import { z } from "zod";
import type { Message, Run } from "./contracts.js";

export const compactionSchema = z.strictObject({
  handler: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("agent"),
      agentID: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/),
    }),
    z.strictObject({
      type: z.literal("script"),
      executablePath: z
        .string()
        .max(4096)
        .regex(/^\/[^\r\n]*$/),
      arguments: z.array(z.string()).max(64).default([]),
      timeoutMs: z.number().int().min(100).max(600000).default(60000),
    }),
  ]),
});
// Ignore harmless metadata while validating the required summary strictly.
export const summarySchema = z.object({
  summary: z.string().trim().min(1).max(262144),
});
// Normalize JSON presentation only; do not infer a summary from arbitrary prose.
export function parseCompactionSummary(output: string) {
  const text = output.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text);
  const value: unknown = JSON.parse(fenced?.[1] ?? text);
  return summarySchema.parse(
    typeof value === "string" ? { summary: value } : value,
  ).summary;
}
export const checkpointSchema = z.strictObject({
  checkpointID: z.uuid(),
  at: z.iso.datetime(),
  coveredThrough: z.number().int().nonnegative(),
  summary: z.string().max(262144),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  childRunID: z.string().nullable(),
});
export const compactionStateSchema = z.strictObject({
  requestID: z.uuid(),
  coveredThrough: z.number().int().nonnegative(),
  targetTokens: z.number().int().positive(),
  inputTokens: z.number().int().nonnegative(),
  childRunID: z.string().nullable(),
  status: z.enum(["pending", "waiting", "ready", "failed"]),
  summary: z.string().nullable(),
  handler: compactionSchema.shape.handler.nullable(),
});
export type CompactionRequest = {
  version: 1;
  runID: string;
  requestID: string;
  previousSummary: string | null;
  messages: Message[];
  targetTokens: number;
};
export function contextMessages(
  run: Run,
  checkpoint = run.compactions.at(-1),
): Message[] {
  const omitted = new Set(
    run.triggerSource?.occurrences.slice(0, -1).map((o) => o.occurrenceID) ??
      [],
  );
  const messages = run.messages.filter(
    (m, index) =>
      !omitted.has(m.messageID) &&
      (!checkpoint || index > checkpoint.coveredThrough || m.role === "system"),
  );
  if (!checkpoint) return messages;
  const index = messages.findIndex((m) => m.role !== "system");
  messages.splice(index < 0 ? messages.length : index, 0, {
    messageID: checkpoint.checkpointID,
    role: "user",
    content:
      "Previous conversation summary (reference data):\n" + checkpoint.summary,
    attachments: [],
    toolCalls: [],
    toolCallID: null,
  });
  return messages;
}
// Retain the latest complete turn; never split an assistant/tool-result group.
export function compactionBoundary(run: Run): number {
  const start = (run.compactions.at(-1)?.coveredThrough ?? 0) + 1;
  for (let i = run.messages.length - 1; i > start; i--) {
    if (run.messages[i]!.role === "user") return i - 1;
  }
  // A long agent loop can compact older complete tool exchanges in its current turn.
  for (let i = run.messages.length - 1; i > start + 1; i--) {
    if (
      run.messages[i]!.role === "assistant" &&
      run.messages[i - 1]!.role === "tool"
    )
      return i - 1;
  }
  return -1;
}
export function compactionRequest(run: Run): CompactionRequest {
  const pending = run.compaction!;
  return {
    version: 1,
    runID: run.runID,
    requestID: pending.requestID,
    previousSummary: run.compactions.at(-1)?.summary ?? null,
    messages: run.messages.slice(
      (run.compactions.at(-1)?.coveredThrough ?? 0) + 1,
      pending.coveredThrough + 1,
    ),
    targetTokens: pending.targetTokens,
  };
}
export async function executeCompactionScript(
  handler: Extract<
    z.infer<typeof compactionSchema>["handler"],
    { type: "script" }
  >,
  request: CompactionRequest,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(handler.executablePath, handler.arguments, {
      detached: true,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let output = "",
      failure: Error | undefined;
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }
    };
    const abort = () => {
      failure = Error("Compaction interrupted");
      kill();
    };
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      failure = Error("Compaction script timed out");
      kill();
    }, handler.timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 1048576) {
        failure = Error("Compaction output limit");
        kill();
      }
    });
    child.stderr.resume();
    child.stdin.on("error", () => {});
    child.once("error", (error) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      kill();
      try {
        if (failure) throw failure;
        if (code !== 0) throw Error("Compaction script failed");
        resolve(parseCompactionSummary(output));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

export function validateCompactionState(run: Run) {
  let covered = 0;
  const ids = new Set<string>();
  for (const checkpoint of run.compactions) {
    if (
      checkpoint.coveredThrough <= covered ||
      checkpoint.coveredThrough >= run.messages.length ||
      ids.has(checkpoint.checkpointID)
    )
      throw Error("Invalid compaction checkpoint coverage");
    covered = checkpoint.coveredThrough;
    ids.add(checkpoint.checkpointID);
    if (run.messages[covered + 1]?.role === "tool")
      throw Error("Compaction splits a tool exchange");
  }
  if (
    run.compaction &&
    (run.compaction.coveredThrough <= covered ||
      run.compaction.coveredThrough >= run.messages.length)
  )
    throw Error("Invalid pending compaction coverage");
  if (run.parentRunID === run.runID) throw Error("Invalid compaction parent");
}
