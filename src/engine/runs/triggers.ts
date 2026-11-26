import { terminal, type UserMessage } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import { fingerprint } from "../../utils/json.js";
import { fail } from "../protocol.js";
import type {
  Dependencies as ParentDependencies,
  Runs,
} from "./submissions.js";

interface Dependencies {
  readonly dependencies: Pick<
    ParentDependencies,
    "storage" | "records" | "configuration" | "runner" | "dispatch" | "instant"
  >;
  readonly main: Pick<Runs, "checkMessage" | "submitLocked">;
}
export class RunTriggers {
  constructor(private readonly ports: Dependencies) {}
  async fireTrigger(
    triggerID: string,
    occurrenceID: string,
    replacement: Omit<UserMessage, "messageID"> | undefined,
    dryRun: boolean,
    scheduled = false,
  ) {
    const hash = (input: Omit<UserMessage, "messageID">) => fingerprint(input);
    const outcome = await this.ports.dependencies.storage.exclusive(
      async () => {
        await this.ports.dependencies.storage.reconcile();
        if (this.ports.dependencies.storage.unreadable.length)
          fail("run_index_unavailable", 503);
        const related: Run[] = [];
        for (const summary of this.ports.dependencies.storage.summaries.values()) {
          const run = await this.ports.dependencies.records.run(summary.runID);
          const sources = [
            run.triggerSource,
            ...run.triggerHistory,
            ...run.pendingInputs.map((p) => p.source),
          ].filter((x): x is NonNullable<typeof x> => !!x);
          const matched = sources.find((x) =>
            x.occurrences.some((o) => o.occurrenceID === occurrenceID),
          );
          const occurrence = matched?.occurrences.find(
            (o) => o.occurrenceID === occurrenceID,
          );
          if (occurrence) {
            if (
              matched!.definition.triggerID !== triggerID ||
              (replacement && hash(replacement) !== occurrence.inputHash)
            )
              fail("message_conflict", 409);
            return {
              outcome: "replayed",
              runID: run.runID,
              occurrenceID,
              changed: false,
            };
          }
          if (
            sources.some(
              (source) => source.definition.triggerID === triggerID,
            ) &&
            !terminal(run.state)
          )
            related.push(run);
        }
        if (this.ports.dependencies.storage.messages.has(occurrenceID))
          fail("message_conflict", 409);
        const trigger =
          this.ports.dependencies.storage.store.triggers.find(
            (t) => t.triggerID === triggerID,
          ) ?? fail("trigger_not_found", 404);
        if (!trigger.enabled) fail("trigger_disabled", 409);
        const agent = this.ports.dependencies.configuration.agent(
          trigger.agentID,
        );
        if (!agent.enabled) fail("agent_disabled", 409);
        const input = replacement ?? trigger.message;
        const message = { ...input, messageID: occurrenceID };
        this.ports.main.checkMessage(message, agent.modelID);
        if (trigger.queuePolicy === "skip" && related.length)
          return {
            outcome: "skipped",
            runID: related[0]!.runID,
            occurrenceID,
            changed: false,
          };
        const occurrence = { occurrenceID, inputHash: hash(input) };
        if (trigger.queuePolicy === "coalesce") {
          for (const candidate of related) {
            const run =
              this.ports.dependencies.runner.liveRun(candidate.runID) ??
              candidate;
            const old = run.pendingInputs.find(
              (p) =>
                !p.cancelled &&
                p.source?.definition.triggerID === triggerID &&
                p.source.definition.revision === trigger.revision &&
                p.agent?.revision === agent.revision,
            );
            if (old) {
              if (run.pendingInputs.length >= 1000)
                fail("pending_input_capacity", 429);
              if (!dryRun) {
                old.cancelled = true;
                run.pendingInputs.push({
                  message,
                  cancelled: false,
                  source: {
                    definition: structuredClone(trigger),
                    admission: scheduled ? "timer" : "manual",
                    occurrences: [occurrence],
                  },
                  agent: structuredClone(agent),
                  skills: old.skills,
                  tools: old.tools,
                });
                this.ports.dependencies.records.event(run, "pendingInput", {
                  messageID: occurrenceID,
                });
                this.ports.dependencies.records.event(run, "coalesced", {
                  messageID: occurrenceID,
                });
                await this.ports.dependencies.records.save(run);
              }
              return {
                outcome: "coalesced",
                runID: run.runID,
                occurrenceID,
                changed: !dryRun,
              };
            }
          }
        }

        const pending =
          trigger.queuePolicy === "coalesce"
            ? related.find(
                (r) =>
                  (r.state === "queued" || r.state === "paused") &&
                  !this.ports.dependencies.dispatch.hasActivity(r.runID) &&
                  !r.events.some((e) => e.type === "started") &&
                  r.triggerSource!.definition.revision === trigger.revision &&
                  r.agent.revision === agent.revision,
              )
            : undefined;
        if (pending) {
          if (pending.triggerSource!.occurrences.length >= 1000)
            fail("occurrence_capacity", 429);
          pending.triggerSource!.occurrences.push(occurrence);
          pending.messages.push({
            ...message,
            role: "user",
            toolCalls: [],
            toolCallID: null,
          });
          this.ports.dependencies.records.event(pending, "message", {
            messageID: occurrenceID,
          });
          this.ports.dependencies.records.event(pending, "coalesced", {
            messageID: occurrenceID,
          });
          if (Buffer.byteLength(JSON.stringify(pending)) > 56 * 1024 * 1024)
            fail("run_capacity", 507);
          if (!dryRun) await this.ports.dependencies.records.save(pending);
          return {
            outcome: "coalesced",
            runID: pending.runID,
            occurrenceID,
            changed: !dryRun,
          };
        }
        const accepted = await this.ports.main.submitLocked(
          trigger.agentID,
          message,
          false,
          dryRun,
          {
            definition: structuredClone(trigger),
            admission: scheduled ? "timer" : "manual",
            occurrences: [occurrence],
          },
        );
        return {
          outcome: "queued",
          runID: accepted.runID,
          occurrenceID,
          changed: !dryRun,
        };
      },
    );
    if (!dryRun && outcome.changed) this.ports.dependencies.dispatch.wake();
    return outcome;
  }
  async activatePending() {
    await this.ports.dependencies.storage.exclusive(async () => {
      for (const runID of [...this.ports.dependencies.storage.pendingRunIDs]) {
        const summary = this.ports.dependencies.storage.summaries.get(runID)!;
        if (
          !terminal(summary.state) ||
          this.ports.dependencies.dispatch.hasActivity(summary.runID)
        )
          continue;
        const r = await this.ports.dependencies.records.run(summary.runID);
        if (
          r.evaluation &&
          ["pending", "running"].includes(r.evaluation.grade.status)
        )
          continue;
        const index = r.pendingInputs.findIndex((p) => !p.cancelled);
        if (index < 0) continue;
        const [pending] = r.pendingInputs.splice(index, 1);
        if (pending!.agent) r.agent = pending!.agent;
        if (pending!.skills) r.skills = pending!.skills;
        if (pending!.tools) r.toolSnapshots = pending!.tools;
        r.interactive =
          !r.evaluation &&
          pending!.source?.admission !== "timer" &&
          this.ports.dependencies.dispatch.instantSlot(r.agent.slotID);
        if (r.evaluation) r.evaluation.grade = { status: "pending" };
        r.deliveryExpected = false;
        r.turnID = pending!.message.messageID;
        r.activeMs = 0;
        r.state = "queued";
        r.pauseReason = null;
        r.error = null;
        r.result = null;
        if (pending!.source) r.triggerHistory.push(pending!.source);
        r.messages.push({
          ...pending!.message,
          role: "user",
          toolCalls: [],
          toolCallID: null,
        });
        this.ports.dependencies.records.event(r, "message", {
          messageID: pending!.message.messageID,
        });
        this.ports.dependencies.records.event(r, "queued", {});
        await this.ports.dependencies.records.save(r);
      }
    });
  }
}
