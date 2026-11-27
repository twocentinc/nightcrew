import { publicSummary } from "../storage/transcript.js";
import { doctor, doctorSchema } from "../server/diagnostics.js";
import { z } from "zod";
import {
  schedulerStatusSchema,
  schedulerSnapshotSchema,
  policyResultSchema,
} from "../engine/scheduling/policy.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { triggerInfoSchema } from "../schemas/agent.js";
import { now, terminal } from "../schemas/common.js";
import { runSummarySchema, statusSchema } from "../schemas/run.js";
import { createOperations } from "../utils/commands/definition.js";
import { type ManagementInput } from "../utils/commands/resources.js";
import { handle as triggerHandler } from "./triggers.js";

export const operationInputs = {
  status: z
    .strictObject({
      details: z.boolean().default(false),
      doctor: z.boolean().default(false),
      scheduler: z.boolean().default(false),
    })
    .refine(
      (v) => !(v.doctor && v.scheduler),
      "Choose doctor or scheduler diagnostics",
    ),
};
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command } = input;
  const raw = input.request ?? {};
  if (command === "status") {
    const options = operationInputs.status.parse(raw);
    if (options.scheduler) return service.explainScheduler();
    if (options.doctor)
      return doctor(service.storage.home, true, async () => ({
        pid: process.pid,
        ...service.status(),
      }));
    const runs = [...service.storage.summaries.values()].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.runID.localeCompare(b.runID),
    );
    const triggerInfo = z
      .object({ items: z.array(triggerInfoSchema) })
      .parse(await triggerHandler(service, { command: "triggers list" }));
    const triggersByAgent = new Map<
      string,
      z.infer<typeof triggerInfoSchema>[]
    >();
    for (const trigger of triggerInfo.items) {
      const list = triggersByAgent.get(trigger.agentID) ?? [];
      list.push(trigger);
      triggersByAgent.set(trigger.agentID, list);
    }
    const groups = new Map<
      string,
      {
        latest: (typeof runs)[number];
        activeRuns: number;
        needsAttention: number;
        activeMs: number;
      }
    >();
    const issues: typeof runs = [];
    let activeMs = 0;
    for (const run of runs) {
      activeMs += run.activeMs;
      if (run.outcome.needsAttention) issues.push(run);
      const group = groups.get(run.agentID) ?? {
        latest: run,
        activeRuns: 0,
        needsAttention: 0,
        activeMs: 0,
      };
      group.activeMs += run.activeMs;
      group.activeRuns += Number(!terminal(run.state));
      group.needsAttention += Number(run.outcome.needsAttention);
      groups.set(run.agentID, group);
    }
    return {
      observedAt: now(),
      pid: process.pid,
      ...(options.details ? { scheduler: service.schedulerStatus() } : {}),
      runtime: service.status(),
      totals: {
        runs: runs.length,
        needsAttention: issues.length,
        activeMs,
      },
      agents: service.storage.store.agents.map((agent) => {
        const own = groups.get(agent.agentID);
        return {
          agentID: agent.agentID,
          name: agent.name,
          enabled: agent.enabled,
          modelID: agent.modelID,
          latestRun: own ? publicSummary(own.latest) : null,
          activeRuns: own?.activeRuns ?? 0,
          needsAttention: own?.needsAttention ?? 0,
          activeMs: own?.activeMs ?? 0,
          triggers: triggersByAgent.get(agent.agentID) ?? [],
        };
      }),
      issues: issues.slice(0, 100).map(publicSummary),
      issuesTruncated: issues.length > 100,
    };
  }
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  status: defineOperation(
    "status",
    "Inspect agents, schedules, recent outcomes and runs needing attention",
    z.union([
      doctorSchema,
      policyResultSchema.extend({ snapshot: schedulerSnapshotSchema }),
      z.object({
        observedAt: z.string(),
        pid: z.number(),
        scheduler: schedulerStatusSchema.optional(),
        runtime: statusSchema,
        totals: z.object({
          runs: z.number(),
          needsAttention: z.number(),
          activeMs: z.number(),
        }),
        agents: z.array(
          z.object({
            agentID: z.string(),
            name: z.string(),
            enabled: z.boolean(),
            modelID: z.string(),
            latestRun: runSummarySchema.nullable(),
            activeRuns: z.number(),
            needsAttention: z.number(),
            activeMs: z.number(),
            triggers: z.array(triggerInfoSchema),
          }),
        ),
        issues: z.array(runSummarySchema),
        issuesTruncated: z.boolean(),
      }),
    ]),
    false,
    "none",
    false,
    "daemon",
    {
      details: { field: "details", overwrite: true },
      scheduler: { field: "scheduler" },
      doctor: { field: "doctor", overwrite: true },
    },
  ),
};
