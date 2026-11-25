import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { validateCompactionState } from "../engine/compaction/format.js";
import { NightcrewError } from "../engine/protocol.js";
import { runOutcome, type outcomeSchema } from "../engine/supervision.js";
import { runSchema, type Run } from "../schemas/run.js";
import type { OperationalLog } from "../server/logging.js";
import { fingerprint } from "../utils/json.js";
import { atomicJSON, boundedRead, readJSON } from "./files.js";
import type { RunIndex } from "./runIndex.js";

export type Summary = Pick<
  Run,
  | "runID"
  | "revision"
  | "createdAt"
  | "updatedAt"
  | "state"
  | "segment"
  | "activeMs"
  | "pauseReason"
  | "held"
> & {
  agentID: string;
  remainingMs: number;
  outcome: z.infer<typeof outcomeSchema>;
};
export const summarize = (r: Run): Summary => ({
  outcome: runOutcome(r),
  runID: r.runID,
  agentID: r.agent.agentID,
  revision: r.revision,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  state: r.state,
  segment: r.segment,
  activeMs: r.activeMs,
  pauseReason: r.pauseReason,
  held: r.held,
  remainingMs: Math.max(0, r.agent.timeoutMs - r.activeMs),
});
/** Run persistence only; it never creates a competing transaction queue. */
export class TranscriptStore {
  constructor(
    private readonly home: string,
    private readonly runIndex: Pick<RunIndex, "checkedMessageIDs" | "index">,
    private readonly logger?: OperationalLog,
  ) {}
  async read(runID: string) {
    try {
      return await boundedRead(() => this.readRun(runID));
    } catch (error) {
      if (
        error instanceof NightcrewError &&
        error.code === "storage.readTimeout"
      )
        this.logger?.emit("storage.readTimeout", { reason: "io" });
      throw error;
    }
  }
  private async readRun(runID: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(runID))
      throw new Error("Invalid run ID");
    const dir = path.join(this.home, "runs", runID);
    const stat = await lstat(dir);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Invalid run directory");
    const r = await readJSON(
      path.join(dir, "state.json"),
      runSchema,
      64 * 1024 * 1024,
    );
    if (r.runID !== runID) throw new Error("Run identity mismatch");
    if (
      new Set([
        ...r.messages.map((x) => x.messageID),
        ...r.pendingInputs.map((p) => p.message.messageID),
      ]).size !==
      r.messages.length + r.pendingInputs.length
    )
      throw new Error("Duplicate transcript message");
    if (r.events.some((x, i) => x.sequence !== i + 1))
      throw new Error("Invalid event order");
    const calls = new Set<string>();
    const results = new Set<string>();
    validateCompactionState(r);
    for (const m of r.messages) {
      if (m.role !== "user" && m.attachments.length)
        throw new Error("Invalid attachments");
      if (m.toolCalls.length && m.role !== "assistant")
        throw new Error("Invalid tool calls");
      for (const c of m.toolCalls) {
        if (calls.has(c.callID)) throw new Error("Duplicate tool call");
        calls.add(c.callID);
      }
      if (m.role === "tool") {
        if (
          !m.toolCallID ||
          !calls.has(m.toolCallID) ||
          results.has(m.toolCallID)
        )
          throw new Error("Invalid tool result");
        results.add(m.toolCallID);
      } else if (m.toolCallID) throw new Error("Invalid tool result reference");
    }
    for (const source of [
      r.triggerSource,
      ...r.triggerHistory,
      ...r.pendingInputs.map((p) => p.source),
    ].filter((x): x is NonNullable<typeof x> => !!x)) {
      if (
        source.definition.agentID !== r.agent.agentID ||
        new Set(source.occurrences.map((o) => o.occurrenceID)).size !==
          source.occurrences.length
      )
        throw new Error("Invalid trigger provenance");
      for (const occurrence of source.occurrences) {
        const message = [
          ...r.messages,
          ...r.pendingInputs.map((p) => ({
            ...p.message,
            role: "user" as const,
            toolCalls: [],
            toolCallID: null,
          })),
        ].find(
          (m) => m.messageID === occurrence.occurrenceID && m.role === "user",
        );
        if (!message) throw new Error("Missing trigger occurrence message");
        const { messageID, role, toolCalls, toolCallID, ...input } = message;
        if (fingerprint(input) !== occurrence.inputHash)
          throw new Error("Trigger occurrence input mismatch");
      }
    }
    return r;
  }
  async write(r: Run, initial = false) {
    r.version = 2;
    runSchema.parse(r);
    this.runIndex.checkedMessageIDs(r);
    const root = path.join(this.home, "runs");
    if (initial) {
      const staging = path.join(root, "." + randomUUID());
      await mkdir(staging, { mode: 0o700 });
      await atomicJSON(path.join(staging, "state.json"), r, 56 * 1024 * 1024);
      // The daemon lock serializes allocation; no externally supplied directory names.
      await rename(staging, path.join(root, r.runID));
      const h = await open(root, "r");
      try {
        await h.sync();
      } finally {
        await h.close();
      }
    } else
      await atomicJSON(
        path.join(root, r.runID, "state.json"),
        r,
        64 * 1024 * 1024,
      );
    this.runIndex.index(r);
  }
}
