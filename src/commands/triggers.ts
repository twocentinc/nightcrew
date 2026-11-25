import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  id,
  now,
  storeSchema,
  terminal,
  triggerDraftSchema,
  triggerSchema,
  userMessageSchema,
  uuid,
  validateConfig,
  type Run,
} from "../engine/contracts.js";
import { checkpoint } from "../engine/execution.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { nextFireAt } from "../engine/triggers.js";
import { canonical } from "../storage/store.js";
import { createOperations } from "./definition.js";
import { type ManagementInput } from "./resources.js";

const revision = z.number().int().positive();
export const operationInputs = {
  "triggers create": z.strictObject({ trigger: triggerDraftSchema }),
  "triggers update": z.strictObject({
    expectedRevision: revision,
    changes: triggerDraftSchema
      .omit({ triggerID: true })
      .partial()
      .extend({
        enabled: z.boolean().optional(),
        queuePolicy: z.enum(["skip", "enqueue", "coalesce"]).optional(),
        message: userMessageSchema.omit({ messageID: true }).optional(),
      }),
  }),
  "triggers delete": z.strictObject({ expectedRevision: revision }),
  "triggers fire": z.strictObject({
    occurrenceID: uuid.optional(),
    message: userMessageSchema.omit({ messageID: true }).optional(),
  }),
};
const requestSchemas: Record<string, z.ZodType> = operationInputs;

const triggerInfo = triggerSchema.extend({
  nextFireAt: z.string().nullable(),
  automaticDispatchEnabled: z.boolean(),
  blockers: z.array(z.string()),
});

export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, resourceID, dryRun = false, yes = false } = input;
  const [resource, action] = command.split(" ");
  const name =
    resourceID === undefined || command === "runs search"
      ? undefined
      : id.parse(resourceID);
  const raw = input.request ?? {};
  if (resource === "triggers") {
    if (action === "fire") {
      const value = requestSchemas[command]!.parse(raw) as {
        occurrenceID?: string;
        message?: Omit<
          import("../engine/contracts.js").UserMessage,
          "messageID"
        >;
      };
      return service.fireTrigger(
        name ?? fail("missing_id"),
        value.occurrenceID ?? randomUUID(),
        value.message,
        dryRun,
      );
    }
    if (action === "list" || action === "get") {
      await service.storage.reconcile();
      const runs: Run[] = [];
      for (const summary of service.storage.summaries.values())
        if (!terminal(summary.state))
          runs.push(await service.run(summary.runID));
      const inspect = (trigger: z.infer<typeof triggerSchema>) => {
        const blockers: string[] = [];
        if (!trigger.enabled) blockers.push("trigger_disabled");
        if (!service.agent(trigger.agentID).enabled)
          blockers.push("agent_disabled");
        if (
          trigger.schedule.type !== "manual" &&
          !service.storage.store.config.scheduler.timersEnabled
        )
          blockers.push("timers_disabled");
        if (
          trigger.queuePolicy === "skip" &&
          runs.some(
            (r) => r.triggerSource?.definition.triggerID === trigger.triggerID,
          )
        )
          blockers.push("unfinished_trigger_run");
        return {
          ...trigger,
          nextFireAt: trigger.enabled
            ? nextFireAt(
                trigger.schedule,
                trigger.anchorAt,
                Date.now(),
                checkpoint,
              )
            : null,
          automaticDispatchEnabled:
            service.storage.store.config.scheduler.timersEnabled,
          blockers,
        };
      };
      const triggers = service.storage.store.triggers;
      if (action === "list")
        return {
          items: triggers
            .map(inspect)
            .sort((a, b) => a.triggerID.localeCompare(b.triggerID)),
        };
      return {
        item: inspect(
          triggers.find((t) => t.triggerID === name) ??
            fail("trigger_not_found", 404),
        ),
      };
    }
    return service.storage.exclusive(async () => {
      const value = requestSchemas[command]?.parse(raw) as
        | {
            trigger?: z.infer<typeof triggerDraftSchema>;
            expectedRevision?: number;
            changes?: Partial<z.infer<typeof triggerDraftSchema>>;
          }
        | undefined;
      if (!value) fail("unknown_command");
      const next = structuredClone(service.storage.store);
      const at = now();
      let item: z.infer<typeof triggerSchema> | null;
      if (action === "create") {
        const draft = value!.trigger!;
        if (next.triggers.some((t) => t.triggerID === draft.triggerID))
          fail("trigger_exists", 409);
        item = triggerSchema.parse({
          ...draft,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          anchorAt: at,
        });
        next.triggers.push(item);
      } else {
        const index = next.triggers.findIndex((t) => t.triggerID === name);
        if (index < 0) fail("trigger_not_found", 404);
        const current = next.triggers[index]!;
        if (current.revision !== value!.expectedRevision)
          fail("revision_conflict", 409);
        if (action === "delete") {
          if (!yes && !dryRun) fail("confirmation_required");
          next.triggers.splice(index, 1);
          item = null;
        } else {
          if (action !== "update") fail("unknown_command");
          const changes = value!.changes!;
          const reset =
            (changes.enabled === true && !current.enabled) ||
            (changes.schedule !== undefined &&
              canonical(changes.schedule) !== canonical(current.schedule));
          item = triggerSchema.parse({
            ...current,
            ...changes,
            anchorAt: reset ? at : current.anchorAt,
            revision: current.revision + 1,
            updatedAt: at,
          });
          next.triggers[index] = item;
        }
      }
      storeSchema.parse(next);
      validateConfig(next);
      if (Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024)
        fail("config_capacity", 413);
      if (!dryRun) await service.storage.saveConfig(next);
      return { item, changed: !dryRun };
    });
  }
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "triggers list": defineOperation(
    "triggers list",
    "Inspect triggers and future schedule occurrences",
    z.object({ items: z.array(triggerInfo) }),
  ),
  "triggers get": defineOperation(
    "triggers get",
    "Inspect a trigger, next occurrence and admission blockers",
    z.object({ item: triggerInfo }),
    false,
    "required",
  ),
  "triggers create": defineOperation(
    "triggers create",
    "create a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "none",
    false,
  ),
  "triggers update": defineOperation(
    "triggers update",
    "update a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "required",
    false,
  ),
  "triggers delete": defineOperation(
    "triggers delete",
    "delete a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "required",
    true,
  ),
  "triggers fire": defineOperation(
    "triggers fire",
    "Manually submit a saved trigger without changing its schedule",
    z.object({
      outcome: z.enum(["queued", "coalesced", "skipped", "replayed"]),
      runID: z.string(),
      occurrenceID: z.uuid(),
      changed: z.boolean(),
    }),
    true,
    "required",
    false,
    "daemon",
  ),
};
