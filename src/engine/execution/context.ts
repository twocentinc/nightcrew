import type { Message } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
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
        recovery: run.recovery?.segment === run.segment ? run.recovery : null,
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
  atStorageLimit(run: Run) {
    return (
      Buffer.byteLength(JSON.stringify(run)) >=
        run.agent.storageLimitMB * 1024 * 1024 ||
      run.messages.length >= 9000 ||
      run.events.length >= 18000 ||
      run.attempts.length >= 9000 ||
      run.hookReceipts.length >= 980
    );
  }
  pauseForStorage(run: Run) {
    if (run.pauseReason !== "storage_limit")
      this.ports.records.event(run, "storageLimit", {
        previousState: run.state,
        limitMB: run.agent.storageLimitMB,
        bytes: Buffer.byteLength(JSON.stringify(run)),
        messages: run.messages.length,
        events: run.events.length,
        attempts: run.attempts.length,
      });
    run.state = "paused";
    run.pauseReason = "storage_limit";
    run.held = true;
    run.error = {
      code: "run_storage_limit",
      message:
        "Run storage limit reached; raise the agent limit before releasing. Exporting does not remove history.",
    };
  }
}
