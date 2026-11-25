import { z } from "zod";
import {
  configSchema,
  id,
  modelSchema,
  slotSchema,
} from "../engine/contracts.js";
import { Service, fail } from "../engine/service.js";
import { capabilities, capabilitiesSchema } from "../server/diagnostics.js";
import { createOperations } from "./definition.js";
import {
  resourceCommand,
  verifyModels,
  type ManagementInput,
  type ResourceActions,
  type ResourceContext,
} from "./resources.js";

const revision = z.number().int().positive();
export const operationInputs = {
  "models create": z.strictObject({
    model: modelSchema,
    slots: z.array(slotSchema).max(32).default([]),
  }),
  "models update": z.strictObject({
    expectedRevision: revision,
    changes: modelSchema.omit({ modelID: true }).partial().extend({
      compactionThresholdTokens: modelSchema.shape.compactionThresholdTokens
        .unwrap()
        .optional(),
      priority: modelSchema.shape.priority.unwrap().optional(),
      slotSnapshots: modelSchema.shape.slotSnapshots.unwrap().optional(),
    }),
  }),
  "models delete": z.strictObject({ expectedRevision: revision }),
};
const requestSchemas: Record<string, z.ZodType> = operationInputs;

const adminConfig = configSchema.omit({ rootTokenHash: true });
const configMutation = z.object({
  changed: z.boolean(),
  restartRequired: z.boolean(),
  config: adminConfig,
  agentID: z.string().optional(),
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

  return resourceCommand(service, input, requestSchemas, resourceActions);
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "models list": defineOperation(
    "models list",
    "List models",
    z.object({ items: z.array(modelSchema) }),
  ),
  "models get": defineOperation(
    "models get",
    "Inspect one model",
    z.object({
      item: modelSchema,
      capabilities: capabilitiesSchema.shape.models.element,
    }),
    false,
    "required",
  ),
  "models create": defineOperation(
    "models create",
    "create models",
    configMutation,
    true,
    "none",
    false,
  ),
  "models update": defineOperation(
    "models update",
    "update models",
    configMutation,
    true,
    "required",
    false,
  ),
  "models delete": defineOperation(
    "models delete",
    "delete models",
    configMutation,
    true,
    "required",
    true,
  ),
};

const resourceActions: ResourceActions = {
  async read({
    service,
    input,
    next,
    registry,
    resource,
    action,
    name,
    dryRun,
    value,
  }: ResourceContext) {
    const items = next.config.models;
    if (action === "list") return { items };
    const item =
      items.find((x) => x.modelID === name) ?? fail("not_found", 404);
    return {
      item,
      capabilities: (
        await capabilities(service.storage.home, next)
      ).models.find((m) => m.modelID === name)!,
    };
  },
  async mutate({
    service,
    input,
    next,
    registry,
    resource,
    action,
    name,
    dryRun,
    value,
  }: ResourceContext) {
    if (
      value.expectedRevision !== undefined &&
      next.config.revision !== value.expectedRevision
    )
      fail("revision_conflict", 409);
    const liveSettingsOnly =
      resource === "config" &&
      Object.keys(value.changes as object).every((k) =>
        [
          "logging",
          "interactionCooldownMs",
          "scheduler",
          "httpEnabled",
        ].includes(k),
      );
    if (!liveSettingsOnly && service.status().queue.length)
      fail("runtime_busy", 409);
    if (action === "create") {
      const model = modelSchema.parse(value.model);
      if (next.config.models.some((m) => m.modelID === model.modelID))
        fail("already_exists", 409);
      next.config.models.push(model);
      const slots = z.array(slotSchema).parse(value.slots);
      if (slots.some((s) => s.modelID !== model.modelID)) fail("invalid_slot");
      next.config.slots.push(...slots);
    } else {
      const index = next.config.models.findIndex((m) => m.modelID === name);
      if (index < 0) fail("not_found", 404);
      if (action === "delete") {
        next.config.models.splice(index, 1);
        next.config.slots = next.config.slots.filter((s) => s.modelID !== name);
      } else
        next.config.models[index] = modelSchema.parse({
          ...next.config.models[index],
          ...(value.changes as object),
        });
    }
    next.config.revision++;
    if (
      resource !== "config" ||
      (value.changes as Record<string, unknown>).models !== undefined
    )
      await verifyModels(next);
  },
};
