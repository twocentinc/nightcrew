import { readdir } from "node:fs/promises";
import path from "node:path";
import { NightcrewError } from "../engine/protocol.js";
import { type Run } from "../schemas/run.js";
import { boundedRead } from "./files.js";
import type { Storage } from "./store.js";
import { summarize, type Summary } from "./transcript.js";

interface Dependencies {
  readonly main: Pick<Storage, "home" | "read">;
}
export class RunIndex {
  constructor(private readonly ports: Dependencies) {}
  summaries = new Map<string, Summary>();
  messages = new Map<string, { runID: string; index: number }>();
  private messageIDsByRun = new Map<string, Set<string>>();
  unreadable: string[] = [];
  readonly pendingRunIDs = new Set<string>();
  readonly compactingRunIDs = new Set<string>();
  checkedMessageIDs(r: Run) {
    const indexedMessages = [
      ...r.messages,
      ...r.pendingInputs.map((p) => ({ ...p.message, role: "user" })),
    ];
    const nextIDs = new Set<string>();
    indexedMessages.forEach((m) => {
      if (m.role !== "user") return;
      const existing = this.messages.get(m.messageID);
      if (nextIDs.has(m.messageID) || (existing && existing.runID !== r.runID))
        throw Error("Duplicate message UUID");
      nextIDs.add(m.messageID);
    });
    return nextIDs;
  }
  index(r: Run) {
    const indexedMessages = [
      ...r.messages,
      ...r.pendingInputs.map((p) => ({ ...p.message, role: "user" })),
    ];
    const nextIDs = this.checkedMessageIDs(r);
    for (const messageID of this.messageIDsByRun.get(r.runID) ?? [])
      this.messages.delete(messageID);
    this.messageIDsByRun.set(r.runID, nextIDs);
    this.summaries.set(r.runID, summarize(r));
    if (r.pendingInputs.some((p) => !p.cancelled))
      this.pendingRunIDs.add(r.runID);
    else this.pendingRunIDs.delete(r.runID);
    if (r.compaction?.status === "waiting" && r.compaction.childRunID)
      this.compactingRunIDs.add(r.runID);
    else this.compactingRunIDs.delete(r.runID);
    indexedMessages.forEach((m, index) => {
      if (m.role === "user")
        this.messages.set(m.messageID, { runID: r.runID, index });
    });
  }
  async reconcile() {
    const entries = await boundedRead(() =>
      readdir(path.join(this.ports.main.home, "runs"), {
        withFileTypes: true,
      }),
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      if (!this.summaries.has(e.name) && !this.unreadable.includes(e.name)) {
        try {
          this.index(await this.ports.main.read(e.name));
        } catch (error) {
          if (
            error instanceof NightcrewError &&
            error.code === "storage.readTimeout"
          )
            throw error;
          this.unreadable.push(e.name);
        }
      }
    }
  }
}
