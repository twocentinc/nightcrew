import { createHash } from "node:crypto";
import type {
  Dispatch,
  Dependencies as ParentDependencies,
} from "./dispatch.js";
import { nextFireAt } from "./schedule.js";

interface Dependencies {
  readonly dependencies: Pick<
    ParentDependencies,
    "storage" | "runs" | "logger"
  >;
  readonly main: Pick<Dispatch, "closed">;
}
export class Timers {
  constructor(private readonly ports: Dependencies) {}
  private triggerDue = new Map<string, { revision: number; at: number }>();
  ticking = false;
  async dispatchTimers() {
    if (this.ticking || this.ports.main.closed) return;
    this.ticking = true;
    try {
      const time = Date.now(),
        enabled =
          this.ports.dependencies.storage.store.config.scheduler.timersEnabled;
      for (const t of this.ports.dependencies.storage.store.triggers) {
        if (!t.enabled || t.schedule.type === "manual" || !enabled) {
          this.triggerDue.delete(t.triggerID);
          continue;
        }
        const prior = this.triggerDue.get(t.triggerID);
        if (!prior || prior.revision !== t.revision) {
          const next = nextFireAt(t.schedule, t.anchorAt, time);
          if (next)
            this.triggerDue.set(t.triggerID, {
              revision: t.revision,
              at: Date.parse(next),
            });
          continue;
        }
        if (time < prior.at) continue;
        const next = nextFireAt(t.schedule, t.anchorAt, time);
        if (next)
          this.triggerDue.set(t.triggerID, {
            revision: t.revision,
            at: Date.parse(next),
          });
        else this.triggerDue.delete(t.triggerID);
        if (time - prior.at > 5000) continue;
        const hex = createHash("sha256")
          .update(t.triggerID + ":" + t.revision + ":" + prior.at)
          .digest("hex");
        const occurrenceID =
          hex.slice(0, 8) +
          "-" +
          hex.slice(8, 12) +
          "-4" +
          hex.slice(13, 16) +
          "-a" +
          hex.slice(17, 20) +
          "-" +
          hex.slice(20, 32);
        try {
          await this.ports.dependencies.runs.fireTrigger(
            t.triggerID,
            occurrenceID,
            undefined,
            false,
            true,
          );
        } catch {
          this.ports.dependencies.logger?.emit("trigger.dispatchFailed", {
            reason: "process",
          });
        }
      }
    } finally {
      this.ticking = false;
    }
  }
}
