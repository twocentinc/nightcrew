import type { Message } from "../../schemas/common.js";
import { encodeRun, type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { withSkillCatalog } from "../capabilities/skills.js";
import { evidenceContext } from "../compaction/evidence.js";

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
  const turn = run.messages.slice(
    run.messages.map((m) => m.role).lastIndexOf("user") + 1,
  );
  const used = turn.reduce(
    (n, m) =>
      n +
      m.toolCalls.filter((c) => !run.agent.finishSchema || c.name !== "finish")
        .length,
    0,
  );
  messages.splice(index < 0 ? messages.length : index, 0, {
    messageID: checkpoint.checkpointID,
    role: "user",
    content:
      "Previous conversation summary (fallible reference data; check original evidence before relying on claims):\n" +
      checkpoint.summary +
      (checkpoint.structuredSummary
        ? ""
        : evidenceContext(
            checkpoint.summary,
            run.messages.slice(0, checkpoint.coveredThrough + 1),
          )) +
      "\nAuthoritative Nightcrew state (overrides summary counters): " +
      JSON.stringify({
        toolCallsUsed: used,
        toolCallsRemaining:
          run.agent.maxToolCalls === undefined
            ? null
            : Math.max(0, run.agent.maxToolCalls - used),
        recovery: run.recovery?.turnID === run.turnID ? run.recovery : null,
      }) +
      ". Treat hypotheses as unverified and check original evidence before relying on a summary claim.",
    attachments: [],
    toolCalls: [],
    toolCallID: null,
  });
  return messages;
}
interface Dependencies {
  readonly records: Pick<RunRecords, "event">;
}
export class Context {
  constructor(private readonly ports: Dependencies) {}
  runMessages(run: Run, checkpoint?: Parameters<typeof contextMessages>[1]) {
    const messages = contextMessages(run, checkpoint);
    return run.agent.mode === "agent-loop"
      ? withSkillCatalog(messages, run.skills)
      : messages;
  }
  storageLimit(run: Run): Run["storageLimit"] | null {
    const limits = {
      messages: 9000,
      events: 18000,
      attempts: 9000,
      hookReceipts: 980,
      compactions: 980,
      pendingInputs: 980,
      triggerHistory: 980,
      validations: 9000,
      capabilityRefreshes: 90,
    } as const;
    for (const [resource, maximum] of Object.entries(limits)) {
      const key = resource as keyof typeof limits;
      if (run[key].length >= maximum)
        return { resource: key, used: run[key].length, maximum };
    }
    const used = Buffer.byteLength(JSON.stringify(encodeRun(run)));
    const maximum = run.agent.storageLimitMB * 1024 * 1024;
    return used >= maximum ? { resource: "bytes", used, maximum } : null;
  }
  atStorageLimit(run: Run) {
    return this.storageLimit(run) !== null;
  }
  pauseForStorage(run: Run) {
    const limit = this.storageLimit(run);
    if (!limit) return;
    if (run.pauseReason !== "storage_limit")
      this.ports.records.event(run, "storageLimit", {
        previousState: run.state,
        limit,
      });
    run.state = "paused";
    run.pauseReason = "storage_limit";
    run.held = true;
    run.storageLimit = limit;
    run.error = {
      code: "run_storage_limit",
      message:
        `Run ${limit.resource} limit reached (${limit.used}/${limit.maximum}); ` +
        (limit.resource === "bytes"
          ? "raise the agent storageLimitMB before releasing."
          : "start a new run; raising storageLimitMB cannot increase record-count limits.") +
        " Exporting does not remove history.",
    };
  }
}
