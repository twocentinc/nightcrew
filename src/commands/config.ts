import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Service, fail } from "../engine/service.js";
import { revision } from "../schemas/common.js";
import {
  adminConfig,
  configMutation,
  configSchema,
} from "../schemas/config.js";
import { loggingSchema } from "../server/logging.js";
import { tokenHash } from "../storage/config.js";
import { createOperations } from "./definition.js";
import {
  configurationChangePolicy,
  exposeConfig,
  resourceCommand,
  verifyModels,
  type ManagementInput,
  type ResourceActions,
  type ResourceContext,
} from "./resources.js";

export const operationInputs = {
  "config update": z.strictObject({
    expectedRevision: revision,
    changes: configSchema
      .omit({ rootTokenHash: true, revision: true })
      .partial()
      .extend({
        httpEnabled: configSchema.shape.httpEnabled.unwrap().optional(),
        logging: loggingSchema.optional(),
        scheduler: z
          .strictObject(
            Object.fromEntries(
              Object.entries(configSchema.shape.scheduler.unwrap().shape).map(
                ([key, field]) => [key, field.unwrap().optional()],
              ),
            ),
          )
          .optional(),
      }),
  }),
};
const requestSchemas: Record<string, z.ZodType> = operationInputs;
const changed = z.object({ changed: z.boolean() });
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, dryRun = false, yes = false } = input;
  if (command === "config reload")
    return { changed: !dryRun, ...(await service.reloadRegistry(dryRun)) };
  if (command === "config token rotate") {
    if (!yes && !dryRun) fail("confirmation_required");
    return service.storage.exclusive(async () => {
      const token = randomBytes(32).toString("base64url");
      if (!dryRun) {
        const next = structuredClone(service.storage.store);
        next.config.rootTokenHash = tokenHash(token);
        next.config.revision++;
        await service.storage.saveConfig(next);
      }
      return { changed: !dryRun, ...(!dryRun ? { token } : {}) };
    });
  }
  if (command === "config get")
    return { config: exposeConfig(service.storage.store) };
  return resourceCommand(service, input, requestSchemas, resourceActions);
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "config token rotate": defineOperation(
    "config token rotate",
    "Replace the HTTP root token and return it once",
    changed.extend({ token: z.string().optional() }),
    true,
    "none",
    true,
  ),
  "config get": defineOperation(
    "config get",
    "Read redacted configuration",
    z.object({ config: adminConfig }),
  ),
  "config update": defineOperation(
    "config update",
    "Apply revision-checked configuration changes",
    configMutation,
    true,
  ),
  "config reload": defineOperation(
    "config reload",
    "Reload skill folders and tool definitions",
    z.object({
      changed: z.boolean(),
      skills: z.number().int(),
      tools: z.number().int(),
    }),
    true,
  ),
};
const resourceActions: ResourceActions = {
  async mutate({ service, next, resource, value }: ResourceContext) {
    if (
      value.expectedRevision !== undefined &&
      next.config.revision !== value.expectedRevision
    )
      fail("revision_conflict", 409);
    const policy = configurationChangePolicy(resource, value.changes);
    if (policy.requiresIdleQueue && service.status().queue.length)
      fail("runtime_busy", 409);
    const changes = value.changes as Partial<typeof next.config>;
    if (Object.keys(changes).length === 0) fail("empty_changes");
    if (changes.scheduler) {
      if (
        policy.resizingScheduler &&
        (service.schedulerStatus().active.length ||
          [...service.chats.values()].some((c) => c.state === "queued"))
      )
        fail("runtime_busy", 409);
      if (changes.scheduler.contextTokens !== undefined)
        next.config.slots = next.config.slots.map((slot) => ({
          ...slot,
          contextTokens: changes.scheduler!.contextTokens!,
        }));
      changes.scheduler = { ...next.config.scheduler, ...changes.scheduler };
    }
    next.config = { ...next.config, ...changes };
    next.config.revision++;
    if (
      resource !== "config" ||
      (value.changes as Record<string, unknown>).models !== undefined
    )
      await verifyModels(next);
  },
};
