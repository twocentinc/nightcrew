import { realpath } from "node:fs/promises";
import type { RunRecords } from "../storage/records.js";
import { Storage } from "../storage/store.js";
import { now, terminal, type Run } from "./contracts.js";
import type { Dispatch } from "./dispatch.js";
import { runExecutable, withoutExecution } from "./execution.js";
import { fail } from "./protocol.js";
import type { Runner } from "./runner.js";

interface Dependencies {
  readonly storage: Storage;
  readonly records: Pick<RunRecords, "run" | "detail" | "save">;
  readonly dispatch: Pick<Dispatch, "hasActivity">;
  readonly runner: Pick<Runner, "liveRun">;
}
export class Hooks {
  constructor(private readonly ports: Dependencies) {}
  private hookWork = new Set<Promise<void>>();
  scheduleHooks(run: Run, eventType?: string) {
    const task = withoutExecution(() =>
      this.deliverHooks(run, eventType),
    ).catch(() => {});
    this.hookWork.add(task);
    void task.finally(() => this.hookWork.delete(task));
  }
  async retryHook(
    runID: string,
    input: {
      expectedRevision: number;
      receiptIndex: number;
      requestID: string;
      note: string;
      acceptUnknown: boolean;
      hookPath?: string;
    },
    dryRun: boolean,
  ) {
    const result = await this.ports.storage.exclusive(async () => {
      const run = await this.ports.records.run(runID);
      const prior = run.hookReceipts.find(
        (h) => h.requestID === input.requestID,
      );
      if (prior) {
        if (
          prior.retryOf !== input.receiptIndex ||
          prior.note !== input.note ||
          (input.hookPath && prior.executablePath !== input.hookPath)
        )
          fail("request_conflict", 409);
        return {
          run: this.ports.records.detail(run),
          changed: false,
          index: null,
        };
      }
      if (run.revision !== input.expectedRevision)
        fail("revision_conflict", 409);
      if (!terminal(run.state) || this.ports.dispatch.hasActivity(runID))
        fail("run_not_terminal", 409);
      const receipt = run.hookReceipts[input.receiptIndex];
      if (!receipt || !["failed", "unknown"].includes(receipt.status))
        fail("hook_not_retryable", 409);
      if (run.hookReceipts.some((h) => h.retryOf === input.receiptIndex))
        fail("hook_already_retried", 409);
      if (receipt.status === "unknown" && !input.acceptUnknown)
        fail("hook_outcome_unknown", 409);
      const event = run.events.find(
        (e) => e.sequence === receipt.eventSequence,
      );
      if (!event || event.segment !== run.segment)
        fail("hook_segment_changed", 409);
      const original = await realpath(receipt.executablePath).catch(
        () => receipt.executablePath,
      );
      const candidates = this.ports.storage.store.config.hooks.filter(
        (h) => h.event === `run.${event.type}` && h.purpose === receipt.purpose,
      );
      let hook;
      for (const candidate of candidates) {
        if (
          input.hookPath
            ? candidate.executablePath === input.hookPath
            : (await realpath(candidate.executablePath).catch(
                () => candidate.executablePath,
              )) === original
        ) {
          hook = candidate;
          break;
        }
      }
      if (!hook) fail("hook_not_registered", 409);
      if (run.hookReceipts.length >= 1000) fail("hook_receipt_capacity", 409);
      const index = run.hookReceipts.length;
      if (!dryRun) {
        run.hookReceipts.push({
          ...receipt,
          executablePath: hook.executablePath,
          requestID: input.requestID,
          retryOf: input.receiptIndex,
          note: input.note,
          status: "pending",
          diagnostic: null,
        });
        await this.ports.records.save(run);
      }
      return {
        run: this.ports.records.detail(run),
        changed: !dryRun,
        index: dryRun ? null : index,
      };
    });
    if (result.index !== null) {
      const work = withoutExecution(async () =>
        this.deliverHooks(
          await this.ports.records.run(runID),
          undefined,
          result.index!,
        ),
      );
      this.hookWork.add(work);
      try {
        await work;
      } finally {
        this.hookWork.delete(work);
      }
    }
    return {
      run: this.ports.records.detail(await this.ports.records.run(runID)),
      changed: result.changed,
    };
  }
  private async deliverHooks(
    r: Run,
    selectedEvent?: string,
    retryIndex?: number,
  ) {
    const retry = retryIndex === undefined ? null : r.hookReceipts[retryIndex];
    const retryEvent = retry
      ? r.events.find((e) => e.sequence === retry.eventSequence)
      : null;
    const eventType =
      retryEvent?.type ??
      selectedEvent ??
      (r.pauseReason === "storage_limit" ? "storageLimit" : r.state);
    const eventName = `run.${eventType}`;
    const event =
      retryEvent ?? [...r.events].reverse().find((e) => e.type === eventType);
    if (!event) return;
    for (const hook of this.ports.storage.store.config.hooks.filter(
      (h) =>
        h.event === eventName &&
        (!retry || h.executablePath === retry.executablePath),
    )) {
      const accepted = await this.ports.storage.exclusive(async () => {
        const current =
          this.ports.runner.liveRun(r.runID) ??
          (await this.ports.records.run(r.runID));
        if (retryIndex !== undefined) {
          const receipt = current.hookReceipts[retryIndex];
          if (!receipt || receipt.status !== "pending") return -1;
        } else if (
          current.hookReceipts.some(
            (h) =>
              h.eventSequence === event.sequence &&
              h.executablePath === hook.executablePath,
          )
        )
          return -1;
        const blocked =
          hook.purpose === "delivery" &&
          r.validations.some((v) => v.segment === event.segment) &&
          r.validations.filter((v) => v.segment === event.segment).at(-1)
            ?.status !== "passed";
        const index = retryIndex ?? current.hookReceipts.length;
        const updated = {
          requestID: retry?.requestID ?? null,
          retryOf: retry?.retryOf ?? null,
          note: retry?.note ?? null,
          eventSequence: event.sequence,
          executablePath: hook.executablePath,
          purpose: hook.purpose,
          status: blocked ? ("failed" as const) : ("started" as const),
          diagnostic: blocked
            ? "Delivery not dispatched: output validation did not pass"
            : null,
        };
        if (retryIndex === undefined) current.hookReceipts.push(updated);
        else current.hookReceipts[index] = updated;
        await this.ports.records.save(current);
        return blocked ? -1 : index;
      });
      if (accepted < 0) continue;
      let hookResult: { ok: boolean; diagnostic: string | null };
      try {
        await runExecutable({
          executable: hook.executablePath,
          env: { PATH: process.env.PATH ?? "" },
          discardOutput: true,
          timeoutMs: hook.timeoutMs,
          input:
            JSON.stringify({
              version: 1,
              event: eventName,
              runID: r.runID,
              agentID: r.agent.agentID,
              segment: event.segment,
              state: eventType === "storageLimit" ? "paused" : eventType,
              eventSequence: event.sequence,
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
        const receipt = current.hookReceipts[accepted]!;
        receipt.status = hookResult.ok ? "succeeded" : "failed";
        receipt.diagnostic = hookResult.diagnostic;
        // Delivery may settle after a follow-up begins; retain its originating segment.
        current.events.push({
          sequence: current.events.length + 1,
          at: now(),
          type: "hookResult",
          segment: event.segment,
          data: { eventSequence: event.sequence, status: receipt.status },
        });
        await this.ports.records.save(current);
      });
    }
  }
  async drain() {
    await Promise.all(this.hookWork);
  }
}
