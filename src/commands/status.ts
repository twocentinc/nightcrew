import { z } from "zod";
import { schedulerStatusSchema } from "../engine/scheduling/policy.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { triggerSchema } from "../schemas/agent.js";
import { now, terminal } from "../schemas/common.js";
import { runSummarySchema, statusSchema } from "../schemas/run.js";
import { createOperations } from "./definition.js";
import { type ManagementInput } from "./resources.js";
import { handle as triggerHandler } from "./triggers.js";

export const operationInputs = {
  status: z.strictObject({ details: z.boolean().default(false) }),
};
const triggerInfo = triggerSchema.extend({
  nextFireAt: z.string().nullable(),
  automaticDispatchEnabled: z.boolean(),
  blockers: z.array(z.string()),
});
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command } = input;
  const [] = command.split(" ");
  const raw = input.request ?? {};
  if (command === "status") {
    const runs = [...service.storage.summaries.values()].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.runID.localeCompare(b.runID),
    );
    const review = runs.filter((r) => r.outcome.needsReview);
    const triggerInfo = (await triggerHandler(service, {
      command: "triggers list",
    })) as {
      items: (z.infer<typeof triggerSchema> & {
        nextFireAt: string | null;
        automaticDispatchEnabled: boolean;
        blockers: string[];
      })[];
    };
    return {
      observedAt: now(),
      pid: process.pid,
      ...(operationInputs.status.parse(raw).details
        ? { scheduler: service.schedulerStatus() }
        : {}),
      runtime: service.status(),
      totals: {
        runs: runs.length,
        needsReview: review.length,
        activeMs: runs.reduce((n, r) => n + r.activeMs, 0),
      },
      agents: service.storage.store.agents.map((agent) => {
        const own = runs.filter((r) => r.agentID === agent.agentID);
        return {
          agentID: agent.agentID,
          name: agent.name,
          enabled: agent.enabled,
          modelID: agent.modelID,
          latestRun: own[0] ?? null,
          activeRuns: own.filter((r) => !terminal(r.state)).length,
          needsReview: own.filter((r) => r.outcome.needsReview).length,
          activeMs: own.reduce((n, r) => n + r.activeMs, 0),
          triggers: triggerInfo.items.filter(
            (t) => t.agentID === agent.agentID,
          ),
        };
      }),
      review: review.slice(0, 100),
      reviewTruncated: review.length > 100,
    };
  }
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  status: defineOperation(
    "status",
    "Inspect agents, schedules, recent outcomes and runs needing review",
    z.object({
      observedAt: z.string(),
      pid: z.number(),
      scheduler: schedulerStatusSchema.optional(),
      runtime: statusSchema,
      totals: z.object({
        runs: z.number(),
        needsReview: z.number(),
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
          needsReview: z.number(),
          activeMs: z.number(),
          triggers: z.array(triggerInfo),
        }),
      ),
      review: z.array(runSummarySchema),
      reviewTruncated: z.boolean(),
    }),
    false,
    "none",
    false,
    "daemon",
    ["details"],
  ),
};
