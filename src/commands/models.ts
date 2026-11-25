import { z } from "zod";
import { Service, fail } from "../engine/service.js";
import { revision } from "../schemas/common.js";
import { configMutation } from "../schemas/config.js";
import { modelSchema, slotSchema } from "../schemas/model.js";
import { capabilities, capabilitiesSchema } from "../server/diagnostics.js";
import { createOperations } from "./definition.js";
import {
  configurationChangePolicy,
  resourceCommand,
  verifyModels,
  type ManagementInput,
  type ResourceActions,
  type ResourceContext,
} from "./resources.js";

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
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
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
  async read({ service, next, action, name }: ResourceContext) {
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
    next,
    resource,
    action,
    name,
    value,
  }: ResourceContext) {
    if (
      value.expectedRevision !== undefined &&
      next.config.revision !== value.expectedRevision
    )
      fail("revision_conflict", 409);
    const policy = configurationChangePolicy(resource, value.changes);
    if (policy.requiresIdleQueue && service.status().queue.length)
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
    await verifyModels(next);
  },
};
