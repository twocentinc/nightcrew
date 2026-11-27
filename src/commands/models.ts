import { z } from "zod";
import { Service, fail } from "../engine/service.js";
import { id, resultSchema, revision, samplingSchema } from "../schemas/common.js";
import { modelSchema } from "../schemas/model.js";
import { capabilities, capabilitiesSchema } from "../server/diagnostics.js";
import { createOperations } from "../utils/commands/definition.js";
import {
  configurationChangePolicy,
  resourceCommand,
  verifyModels,
  type ManagementInput,
  type ResourceActions,
  type ResourceContext,
} from "../utils/commands/resources.js";

export const operationInputs = {
  "models unload": z.strictObject({ all: z.boolean().default(false) }),
  "models test": z.strictObject({
    prompt: z.string().trim().min(1).max(50000),
    maxOutputTokens: z.number().int().min(1).max(4096).default(64),
    sampling: samplingSchema.default(() => samplingSchema.parse({ temperature: 0 })),
    thinking: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(300000).default(60000),
  }),
  "models create": z.strictObject({
    model: modelSchema,
  }),
  "models update": z.strictObject({
    expectedRevision: revision,
    changes: modelSchema.omit({ modelID: true }).partial().extend({
      compactionThresholdTokens: modelSchema.shape.compactionThresholdTokens
        .unwrap()
        .optional(),
      priority: modelSchema.shape.priority.unwrap().optional(),
      contextTokens: modelSchema.shape.contextTokens.unwrap().optional(),
      slotSnapshots: modelSchema.shape.slotSnapshots.unwrap().optional(),
    }),
  }),
  "models delete": z.strictObject({ expectedRevision: revision }),
};
const modelMutation = z.object({
  changed: z.boolean(), restartRequired: z.boolean(), revision, item: modelSchema.nullable(),
});
const requestSchemas: Record<string, z.ZodType> = operationInputs;
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  if (input.command === "models unload") {
    const request = operationInputs["models unload"].parse(input.request ?? {});
    return service.unloadModels(
      input.resourceID === undefined ? undefined : id.parse(input.resourceID),
      request.all,
      input.dryRun,
    );
  }
  if (input.command === "models test")
    return service.testModel(
      id.parse(input.resourceID),
      operationInputs["models test"].parse(input.request),
      input.dryRun,
    );
  return resourceCommand(service, input, requestSchemas, resourceActions);
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "models test": defineOperation(
    "models test",
    "Test chat model weights with a temporary prompt; requires an idle runtime",
    z.object({
      modelID: id,
      changed: z.boolean(),
      elapsedMs: z.number().nonnegative(),
      result: resultSchema.nullable(),
    }),
    true,
    "required",
    false,
    "daemon",
    { prompt: { field: "prompt" } },
  ),
  "models unload": defineOperation(
    "models unload",
    "Unload one model or all resident models; reject active work and preserve disk caches",
    z.object({
      modelIDs: z.array(id),
      unloadedModelIDs: z.array(id),
      changed: z.boolean(),
    }),
    true,
    "optional",
    false,
    "daemon",
    { all: { field: "all" } },
  ),
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
    modelMutation,
    true,
    "none",
    false,
  ),
  "models update": defineOperation(
    "models update",
    "update models",
    modelMutation,
    true,
    "required",
    false,
  ),
  "models delete": defineOperation(
    "models delete",
    "delete models",
    modelMutation,
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
    } else {
      const index = next.config.models.findIndex((m) => m.modelID === name);
      if (index < 0) fail("not_found", 404);
      if (action === "delete") {
        next.config.models.splice(index, 1);
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
