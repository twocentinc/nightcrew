import { gradeRun } from "./evals/results.js";
import { randomUUID } from "node:crypto";
import { now, terminal } from "../schemas/common.js";
import { type Run } from "../schemas/run.js";
import type { RunRecords } from "../storage/records.js";
import { Storage } from "../storage/store.js";
import { runExecutable, withoutExecution } from "./execution/process.js";
import type { Runner } from "./execution/runner.js";

interface Dependencies {
  readonly storage: Storage;
  readonly records: Pick<RunRecords, "run" | "save" | "event">;
  readonly runner: Pick<Runner, "liveRun">;
}
export class Hooks {
  constructor(private readonly ports: Dependencies) {}
  private hookWork = new Set<Promise<void>>();
  scheduleHooks(run: Run, eventType?: string) {
    const task = withoutExecution(() =>
      run.evaluation
        ? this.gradeEval(run.runID)
        : this.deliverHooks(run, eventType),
    ).catch(() => {});
    this.hookWork.add(task);
    void task.finally(() => this.hookWork.delete(task));
  }
  private async gradeEval(runID: string) {
    const run = await this.ports.storage.exclusive(async () => {
      const current = await this.ports.records.run(runID);
      if (
        !current.evaluation ||
        current.parentRunID ||
        !terminal(current.state) ||
        current.evaluation.grade.status !== "pending"
      )
        return null;
      current.evaluation.grade = { status: "running", startedAt: now() };
      await this.ports.records.save(current);
      return current;
    });
    if (!run) return;
    const grade = await gradeRun(run).catch((error) => ({
      status: "error" as const,
      reason:
        error instanceof Error
          ? error.message.slice(0, 8000)
          : "Grading failed",
      finishedAt: now(),
    }));
    await this.ports.storage.exclusive(async () => {
      const current = await this.ports.records.run(runID);
      if (
        current.turnID !== run.turnID ||
        current.evaluation?.grade.status !== "running"
      )
        return;
      current.evaluation.grade = grade;
      this.ports.records.event(current, "evalGraded", grade);
      await this.ports.records.save(current);
    });
  }
  private async deliverHooks(r: Run, selectedEvent?: string) {
    const eventType =
      selectedEvent ??
      (r.pauseReason === "storageLimit" ? "storageLimit" : r.state);
    const eventName = `run.${eventType}`;
    const event = [...r.events].reverse().find((e) => e.type === eventType);
    if (!event) return;
    for (const hook of this.ports.storage.store.config.hooks.filter(
      (h) => h.event === eventName,
    )) {
      const accepted = await this.ports.storage.exclusive(async () => {
        const current =
          this.ports.runner.liveRun(r.runID) ??
          (await this.ports.records.run(r.runID));
        if (
          current.hookReceipts.some(
            (h) => h.eventID === event.eventID && h.hookID === hook.hookID,
          )
        )
          return null;
        const blocked =
          hook.purpose === "delivery" &&
          r.validations.some((v) => v.turnID === event.turnID) &&
          r.validations.filter((v) => v.turnID === event.turnID).at(-1)
            ?.status !== "passed";
        const receiptID = randomUUID();
        const updated = {
          receiptID,
          hookID: hook.hookID,
          startedAt: blocked ? null : now(),
          finishedAt: blocked ? now() : null,
          eventID: event.eventID,
          executablePath: hook.executablePath,
          purpose: hook.purpose,
          status: blocked ? ("failed" as const) : ("started" as const),
          diagnostic: blocked
            ? "Delivery not dispatched: output validation did not pass"
            : null,
        };
        current.hookReceipts.push(updated);
        await this.ports.records.save(current);
        return blocked ? null : receiptID;
      });
      if (accepted === null) continue;
      let hookResult: { ok: boolean; diagnostic: string | null };
      try {
        await runExecutable({
          executable: hook.executablePath,
          argv: hook.argv,
          env: { PATH: process.env.PATH ?? "" },
          discardOutput: true,
          timeoutMs: hook.timeoutMs,
          input:
            JSON.stringify({
              version: 1,
              event: eventName,
              runID: r.runID,
              agentID: r.agent.agentID,
              turnID: event.turnID,
              state: eventType === "storageLimit" ? "paused" : eventType,
              eventID: event.eventID,
              eventSequence: event.sequence,
              hookID: hook.hookID,
              receiptID: accepted,
              ...(eventType === "storageLimit" ? { storage: event.data } : {}),
              result: r.result,
              error: r.error,
            }) + "\n",
          errors: {
            timeout: `Hook timed out after ${hook.timeoutMs} ms`,
            interrupted: "Hook interrupted",
            limit: "Hook output limit",
            failed: (code, signal) =>
              `Hook exited with code ${code}, signal ${signal ?? "none"}`,
          },
        });
        hookResult = { ok: true, diagnostic: null };
      } catch (error) {
        hookResult = {
          ok: false,
          diagnostic:
            error instanceof Error
              ? error.message.slice(0, 2000)
              : "Hook failed",
        };
      }
      await this.ports.storage.exclusive(async () => {
        const current =
          this.ports.runner.liveRun(r.runID) ??
          (await this.ports.records.run(r.runID));
        const receipt = current.hookReceipts.find(
          (h) => h.receiptID === accepted,
        )!;
        receipt.status = hookResult.ok ? "succeeded" : "failed";
        receipt.diagnostic = hookResult.diagnostic;
        receipt.finishedAt = now();
        // Delivery may settle after a follow-up begins; retain its originating turnID.
        current.events.push({
          eventID: randomUUID(),
          sequence: current.events.length + 1,
          at: now(),
          type: "hookResult",
          turnID: event.turnID,
          data: {
            receiptID: receipt.receiptID,
            sourceEventID: event.eventID,
            status: receipt.status,
          },
        });
        await this.ports.records.save(current);
      });
    }
  }
  async drain() {
    await Promise.all(this.hookWork);
  }
}
