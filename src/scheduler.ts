import { createHash } from "node:crypto";
import { z } from "zod";
import { spawn } from "node:child_process";
import type { Config } from "./contracts.js";
export const schedulerSchema = z.strictObject({
  instantModelID: z.string().min(1).max(128).nullable().default(null),
  maxConcurrent: z.number().int().min(1).max(16).default(1),
  contextTokens: z.number().int().min(1024).max(262144).default(4096),
  snapshotBudgetMB: z.number().int().min(0).max(1048576).default(1024),
  minResidencyMs: z.number().int().min(0).max(3600000).default(60000),
  maxWaitMs: z.number().int().min(1000).max(86400000).default(900000),
  timersEnabled: z.boolean().default(true),
  hook: z
    .strictObject({
      executablePath: z.string().regex(/^\//),
      arguments: z.array(z.string()).max(64).default([]),
      timeoutMs: z.number().int().min(100).max(30000).default(2000),
      failurePolicy: z.enum(["builtin", "hold"]).default("builtin"),
    })
    .nullable()
    .default(null),
});
export type SchedulerConfig = z.infer<typeof schedulerSchema>;
export type Candidate = {
  runID: string;
  modelID: string;
  priority: number;
  modelPriority: number;
  waitingSince: number;
};
export type SchedulerSnapshot = {
  now: number;
  eligible: boolean;
  blockers: string[];
  residentModelID: string | null;
  residentSince: number;
  settings: SchedulerConfig;
  pending: Candidate[];
  active: { runID: string; modelID: string; slotID: string }[];
  slots: { slotID: string; modelID: string }[];
};
export const planSchema = z.strictObject({
  start: z
    .array(z.strictObject({ runID: z.string(), slotID: z.string() }))
    .max(16),
  pause: z.array(z.string()).max(16),
  reason: z.string().max(1000),
});
export const schedulerSnapshotSchema = z.object({
  now: z.number(), eligible: z.boolean(), blockers: z.array(z.string()),
  residentModelID: z.string().nullable(), residentSince: z.number(), settings: schedulerSchema,
  pending: z.array(z.object({runID:z.string(), modelID:z.string(), priority:z.number(), modelPriority:z.number(), waitingSince:z.number()})),
  active: z.array(z.object({runID:z.string(), modelID:z.string(), slotID:z.string()})),
  slots: z.array(z.object({slotID:z.string(), modelID:z.string()})),
});
export const policyResultSchema = z.object({plan:planSchema, source:z.enum(["builtin", "hook", "hold", "fallback"]), diagnostic:z.string().nullable()});
export const schedulerStatusSchema = z.object({
  instantModelID:z.string().nullable(), residentModelID:z.string().nullable(),
  active:z.array(z.object({id:z.string(), kind:z.enum(["run", "chat"]), slotID:z.string(), modelID:z.string()})),
  lastDecision:policyResultSchema.extend({at:z.string()}).nullable(),
});
export type Plan = z.infer<typeof planSchema>;
export function instantModelID(config: Config): string | null {
  return (
    config.scheduler?.instantModelID ??
    config.slots.find(
      (s) =>
        s.instant &&
        config.models.some((m) => m.modelID === s.modelID && m.kind === "chat"),
    )?.modelID ??
    config.models.find((m) => m.kind === "chat")?.modelID ??
    null
  );
}
export function executionSlots(config: Config) {
  if (!config.scheduler) return config.slots;
  return config.models.flatMap((model) => {
    const legacy = config.slots.filter((s) => s.modelID === model.modelID);
    const contextTokens =
      legacy[0]?.contextTokens ?? config.scheduler.contextTokens;
    const instant = model.modelID === instantModelID(config);
    const instantIndex = legacy.find((s) => s.instant)?.index ?? 0;
    const count = Math.max(
      legacy.length,
      (model.kind === "audio" ? 1 : config.scheduler.maxConcurrent) +
        Number(instant),
    );
    return Array.from({ length: count }, (_, index) => ({
      ...(legacy[index] ?? {
        slotID: `pool-${createHash("sha256").update(model.modelID).digest("hex").slice(0, 16)}-${index}`,
        modelID: model.modelID,
        index,
        contextTokens,
      }),
      instant: instant && index === instantIndex,
    }));
  });
}
export function defaultPlan(s: SchedulerSnapshot): Plan {
  const wait = (reason: string): Plan => ({ start: [], pause: [], reason });
  if (!s.eligible)
    return {
      ...wait(s.blockers.join(", ")),
      pause: s.active.map((a) => a.runID),
    };
  if (!s.pending.length) return wait("No eligible queued work");
  const sorted = [...s.pending].sort((a, b) => {
    const overdueA = s.now - a.waitingSince >= s.settings.maxWaitMs;
    const overdueB = s.now - b.waitingSince >= s.settings.maxWaitMs;
    return (
      Number(overdueB) - Number(overdueA) ||
      (overdueA && overdueB
        ? a.waitingSince - b.waitingSince
        : b.modelPriority - a.modelPriority ||
          b.priority - a.priority ||
          a.waitingSince - b.waitingSince) ||
      a.runID.localeCompare(b.runID)
    );
  });
  const first = sorted[0]!;
  const resident = sorted.filter((c) => c.modelID === s.residentModelID);
  const oldEnough = s.now - first.waitingSince >= s.settings.maxWaitMs;
  if (
    s.active.length &&
    !resident.length &&
    s.active[0]!.modelID !== first.modelID &&
    (!oldEnough || s.now - s.residentSince < s.settings.minResidencyMs)
  )
    return wait("Finish active resident work before switching models");
  const keep =
    resident.length &&
    (!oldEnough ||
      first.modelID === s.residentModelID ||
      s.now - s.residentSince < s.settings.minResidencyMs);
  const model = keep ? s.residentModelID! : first.modelID;
  if (s.active.some((a) => a.modelID !== model))
    return {
      start: [],
      pause: s.active.map((a) => a.runID),
      reason: "Yield resident model for waiting work",
    };
  const slots = s.slots.filter(
    (slot) =>
      slot.modelID === model && !s.active.some((a) => a.slotID === slot.slotID),
  );
  const candidates = sorted.filter((c) => c.modelID === model);
  const capacity = Math.min(
    slots.length,
    Math.max(0, s.settings.maxConcurrent - s.active.length),
  );
  return {
    start: candidates
      .slice(0, capacity)
      .map((c, i) => ({ runID: c.runID, slotID: slots[i]!.slotID })),
    pause: [],
    reason: keep
      ? "Batch work on the resident model"
      : "Select highest-priority or longest-waiting work",
  };
}
export function validatePlan(snapshot: SchedulerSnapshot, plan: Plan) {
  if (
    new Set(plan.pause).size !== plan.pause.length ||
    plan.pause.some((id) => !snapshot.active.some((a) => a.runID === id))
  )
    throw Error("Invalid pause selection");
  if (plan.pause.length && plan.start.length)
    throw Error("Pause must settle before starting other work");
  const models = new Set(snapshot.active.map((a) => a.modelID));
  const used = new Set(snapshot.active.map((a) => a.slotID)),
    ids = new Set<string>();
  if (plan.start.length && !snapshot.eligible)
    throw Error("Background work is blocked");
  if (
    plan.start.length + snapshot.active.length >
    snapshot.settings.maxConcurrent
  )
    throw Error("Concurrency limit");
  for (const start of plan.start) {
    const candidate = snapshot.pending.find((c) => c.runID === start.runID),
      slot = snapshot.slots.find((s) => s.slotID === start.slotID);
    if (
      !candidate ||
      !slot ||
      candidate.modelID !== slot.modelID ||
      used.has(slot.slotID) ||
      ids.has(start.runID)
    )
      throw Error("Invalid slot allocation");
    used.add(slot.slotID);
    ids.add(start.runID);
    models.add(candidate.modelID);
  }
  if (models.size > 1) throw Error("Only one model may be resident");
}
export async function policyPlan(
  snapshot: SchedulerSnapshot,
): Promise<{ plan: Plan; source: string; diagnostic: string | null }> {
  const builtin = () => defaultPlan(snapshot),
    hook = snapshot.settings.hook;
  if (!hook) return { plan: builtin(), source: "builtin", diagnostic: null };
  const { remainingTimeout, executionSignal, checkpoint } =
    await import("./execution.js");
  checkpoint();
  const signal = executionSignal();
  try {
    const plan = await new Promise<Plan>((resolve, reject) => {
      const child = spawn(hook.executablePath, hook.arguments, {
        detached: true,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        error: Error | null = null;
      const kill = (message: string) => {
        error = Error(message);
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
      };
      const abort = () => kill("Scheduler hook interrupted");
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      const timer = setTimeout(
        () => kill("Scheduler hook timed out"),
        remainingTimeout(hook.timeoutMs),
      );
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (Buffer.byteLength(stdout) > 1048576)
          kill("Scheduler hook output limit");
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      child.once("error", (e) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(e);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {}
        }
        try {
          if (error) throw error;
          if (code !== 0) throw Error("Scheduler hook failed");
          resolve(planSchema.parse(JSON.parse(stdout)));
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(
        JSON.stringify({
          version: 1,
          ...snapshot,
          settings: { ...snapshot.settings, hook: undefined },
        }),
      );
    });
    validatePlan(snapshot, plan);
    return { plan, source: "hook", diagnostic: null };
  } catch {
    checkpoint();
    return {
      plan:
        hook.failurePolicy === "hold"
          ? {
              start: [],
              pause: [],
              reason: "Scheduler hook failed; background dispatch held",
            }
          : builtin(),
      source: hook.failurePolicy === "hold" ? "hold" : "fallback",
      diagnostic:
        "Scheduler hook failed, timed out, or returned an invalid plan",
    };
  }
}
