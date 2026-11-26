import { executionRecord, workingExecution } from "../schemas/execution.js";
import { RunDocuments } from "./runDocument.js";
import { lstat, mkdir } from "node:fs/promises";
import path from "node:path";
import type { z } from "zod";
import { validateCompactionState } from "../engine/compaction/format.js";
import { NightcrewError } from "../engine/protocol.js";
import { runOutcome, type outcomeSchema } from "../engine/supervision.js";
import {
  validateTranscript,
  encodeRun,
  decodeRun,
  type Run,
} from "../schemas/run.js";
import type { OperationalLog } from "../server/logging.js";
import { fingerprint } from "../utils/json.js";
import { boundedRead } from "./files.js";
import type { RunIndex } from "./runIndex.js";

export type Summary = Pick<
  Run,
  | "runID"
  | "revision"
  | "createdAt"
  | "updatedAt"
  | "state"
  | "turnID"
  | "activeMs"
  | "pauseReason"
  | "held"
> & {
  agentID: string;
  remainingMs: number;
  outcome: z.infer<typeof outcomeSchema>;
  execution: import("../schemas/execution.js").ExecutionState;
};
export const summarize = (r: Run): Summary => ({
  outcome: runOutcome(r),
  execution: executionRecord(r),
  runID: r.runID,
  agentID: r.agent.agentID,
  revision: r.revision,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  state: r.state,
  turnID: r.turnID,
  activeMs: r.activeMs,
  pauseReason: r.pauseReason,
  held: r.held,
  remainingMs: Math.max(0, r.agent.timeoutMs - r.activeMs),
});
/** Run persistence only; it never creates a competing transaction queue. */
export class TranscriptStore {
  private documents: RunDocuments;
  constructor(
    private readonly home: string,
    private readonly runIndex: Pick<RunIndex, "checkedMessageIDs" | "index">,
    private readonly logger?: OperationalLog,
  ) {
    this.documents = new RunDocuments(path.join(home, "runs"));
  }
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
    const r = decodeRun(await this.documents.read(runID));
    if (r.runID !== runID) throw new Error("Run identity mismatch");
    validateTranscript(r);
    validateCompactionState(r);
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
    r.version = 4;
    const record = encodeRun(r);
    this.runIndex.checkedMessageIDs(r);
    await mkdir(path.join(this.home, "runs"), { recursive: true, mode: 0o700 });
    await this.documents.write(record, initial);
    this.runIndex.index({ ...r, ...workingExecution(record.execution) });
  }
}

export function publicSummary(summary: Summary) {
  const { state, held, pauseReason, ...rest } = summary;
  return rest;
}
