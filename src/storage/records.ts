import { randomUUID } from "node:crypto";
import { checkpoint } from "../engine/execution/process.js";
import { fail } from "../engine/protocol.js";
import { now, terminal } from "../schemas/common.js";
import { eventSchema, type Event } from "../schemas/event.js";
import { type Run } from "../schemas/run.js";
import { Storage } from "./store.js";
import { summarize, publicSummary } from "./transcript.js";

type PageSnapshot = {
  key: string;
  items: unknown[];
  expires: number;
  bytes: number;
};
type Page = { snapshot: PageSnapshot; offset: number };
interface Dependencies {
  readonly storage: Storage;
}
export class RunRecords {
  constructor(private readonly ports: Dependencies) {}
  event<T extends Event["type"]>(
    r: Run,
    type: T,
    data: Extract<Event, { type: T }>["data"],
  ) {
    r.events.push(
      eventSchema.parse({
        eventID: randomUUID(),
        sequence: r.events.length + 1,
        at: now(),
        type,
        segment: r.segment,
        data,
      }),
    );
  }
  async save(r: Run) {
    r.revision++;
    r.updatedAt = now();
    await this.ports.storage.write(r);
  }
  async run(runID: string) {
    if (!this.ports.storage.summaries.has(runID)) fail("run_not_found", 404);
    return this.ports.storage.read(runID);
  }
  detail(r: Run) {
    return {
      ...publicSummary(summarize(r)),
      ...(r.evaluation ? { evaluation: r.evaluation } : {}),
      contextUsage: r.contextUsage,
      capabilityRefreshes: r.capabilityRefreshes,
      validations: r.validations,
      recovery: r.recovery,
      compactions: r.compactions,
      compaction: r.compaction,
      parentRunID: r.parentRunID,
      agent: r.agent,
      triggerSource: r.triggerSource,
      pendingInputs: r.pendingInputs,
      skills: r.skills,
      result: r.result,
      hookReceipts: r.hookReceipts.map(({ executablePath, ...x }) => x),
    };
  }
  page<T>(
    key: string,
    input: { limit: number; cursor?: string },
    items: () => Promise<T[]> | T[],
  ) {
    return this.paginate(key, input, items);
  }
  private async paginate<T>(
    key: string,
    { limit, cursor }: { limit: number; cursor?: string },
    get: () => Promise<T[]> | T[],
  ) {
    for (const [id, page] of this.pages)
      if (page.snapshot.expires < Date.now()) this.pages.delete(id);
    let p: Page;
    if (cursor) {
      p = this.pages.get(cursor) ?? fail("cursor_expired", 410);
      if (p.snapshot.key !== key + "|" + limit) fail("cursor_query_mismatch");
    } else {
      const items = structuredClone(await get());
      p = {
        snapshot: {
          key: key + "|" + limit,
          items,
          expires: Date.now() + 300000,
          bytes: Buffer.byteLength(JSON.stringify(items)),
        },
        offset: 0,
      };
    }
    const result = p.snapshot.items.slice(p.offset, p.offset + limit) as T[];
    const offset = p.offset + limit;
    let nextCursor: string | null = null;
    if (offset < p.snapshot.items.length) {
      const snapshots = new Set(
        [...this.pages.values()].map((page) => page.snapshot),
      );
      snapshots.add(p.snapshot);
      const bytes = [...snapshots].reduce(
        (sum, snapshot) => sum + snapshot.bytes,
        0,
      );
      if (this.pages.size >= 100 || bytes > 128 * 1024 * 1024)
        fail("cursor_capacity", 429);
      nextCursor = randomUUID();
      this.pages.set(nextCursor, { snapshot: p.snapshot, offset });
    }
    return { items: result, nextCursor };
  }
  private pages = new Map<string, Page>();
  async listRuns(agentID?: string, state?: string) {
    await this.ports.storage.reconcile();
    return [...this.ports.storage.summaries.values()]
      .filter(
        (r) =>
          (!agentID || r.agentID === agentID) && (!state || r.state === state),
      )
      .sort(
        (a, b) =>
          a.createdAt.localeCompare(b.createdAt) ||
          a.runID.localeCompare(b.runID),
      );
  }
  transcript(r: Run) {
    const attempts = new Map<string, Run["attempts"][number]>();
    for (const attempt of r.attempts)
      if (!attempts.has(attempt.attemptID))
        attempts.set(attempt.attemptID, attempt);
    const allMessages = [
      ...r.messages,
      ...r.pendingInputs.map((p) => ({
        ...p.message,
        role: "user" as const,
        toolCalls: [],
        toolCallID: null,
      })),
    ];
    const messages = new Map<string, (typeof allMessages)[number]>();
    for (const message of allMessages)
      if (!messages.has(message.messageID))
        messages.set(message.messageID, message);
    return r.events.map((e) => ({
      ...e,
      attempt:
        e.data &&
        typeof e.data === "object" &&
        !Array.isArray(e.data) &&
        "attemptID" in e.data
          ? (attempts.get(e.data.attemptID as string) ?? null)
          : null,
      message:
        e.data &&
        typeof e.data === "object" &&
        !Array.isArray(e.data) &&
        "messageID" in e.data
          ? (messages.get(e.data.messageID as string) ?? null)
          : null,
    }));
  }
  async search(query: string, agentID?: string, state?: string) {
    const matches = [];
    for (const s of await this.listRuns(agentID, state)) {
      checkpoint();
      const r = await this.run(s.runID);
      const seen = new Set<string>();
      for (const e of this.transcript(r)) {
        if (e.message && seen.has(e.message.messageID)) continue;
        if (e.message) seen.add(e.message.messageID);
        const text =
          (e.message?.content ?? "") +
          (e.message && "reasoningContent" in e.message
            ? (e.message.reasoningContent ?? "")
            : "") +
          (e.attempt?.text ?? "") +
          (e.attempt?.reasoningContent ?? "") +
          (e.message?.attachments
            .filter((a) => a.mediaType !== "audio/wav")
            .map(
              (a) =>
                "\n" + Buffer.from(a.dataBase64, "base64").toString("utf8"),
            )
            .join("") ?? "");
        const offset = text.toLowerCase().indexOf(query.toLowerCase());
        if (offset >= 0) {
          const start = Math.max(0, offset - 200);
          matches.push({
            runID: r.runID,
            eventSequence: e.sequence,
            segment: e.segment,
            excerpt: text.slice(start, start + 1000),
            matchOffset: offset - start,
          });
        }
      }
      if (r.result && !r.messages.some((m) => m.content === r.result)) {
        const offset = r.result.toLowerCase().indexOf(query.toLowerCase());
        const event = [...r.events]
          .reverse()
          .find((e) => e.type === "completed");
        if (offset >= 0 && event) {
          const start = Math.max(0, offset - 200);
          matches.push({
            runID: r.runID,
            eventSequence: event.sequence,
            segment: event.segment,
            excerpt: r.result.slice(start, start + 1000),
            matchOffset: offset - start,
          });
        }
      }
    }
    return matches;
  }

  /** Caller holds the startup storage transaction. Never replay uncertain deliveries. */
  async recoverInterrupted() {
    for (const summary of this.ports.storage.summaries.values()) {
      const r = await this.ports.storage.read(summary.runID);
      let changed = false;
      if (r.evaluation?.grade.status === "running") {
        r.evaluation.grade = {
          status: "error",
          reason:
            "Daemon stopped during grading; executable outcome is unknown and was not retried",
          finishedAt: now(),
        };
        this.event(r, "evalGraded", r.evaluation.grade);
        changed = true;
      }
      for (const receipt of r.hookReceipts)
        if (receipt.status === "started" || receipt.status === "pending") {
          receipt.status = "unknown";
          receipt.finishedAt = null; // The actual finish time was not observed.
          receipt.diagnostic = "Daemon stopped during delivery; not retried";
          changed = true;
        }
      for (const attempt of r.attempts)
        if (attempt.status === "running") {
          attempt.status = "interrupted";
          attempt.reason = "restart";
          attempt.updatedAt = now();
          changed = true;
        }
      if (!terminal(r.state) && r.state !== "queued") {
        r.state = "paused";
        if (
          r.pauseReason !== "storage_limit" &&
          r.pauseReason !== "runtime_error" &&
          r.pauseReason !== "context_full"
        )
          r.pauseReason = "restart";
        this.event(r, "interrupted", {});
        changed = true;
      }
      if (changed) await this.save(r);
    }
  }
}
