import { toolDefinitionSchema } from "../schemas/tool.js";
import { z } from "zod";
import { builtinTools } from "../engine/capabilities/registry.js";
import { Service, fail } from "../engine/service.js";
import { fingerprint } from "../utils/json.js";
import { createOperations } from "../utils/commands/definition.js";
import {
  mutateRegistration,
  resourceCommand,
  type ManagementInput,
  type ResourceActions,
  type ResourceContext,
} from "../utils/commands/resources.js";

export const operationInputs = {
  "tools create": z.strictObject({ tool: toolDefinitionSchema }),
  "tools update": z.strictObject({
    expectedHash: z.string(),
    tool: toolDefinitionSchema,
  }),
  "tools delete": z.strictObject({ expectedHash: z.string() }),
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
  "tools list": defineOperation(
    "tools list",
    "List tools",
    z.object({
      items: z.array(
        toolDefinitionSchema.safeExtend({
          hash: z.string(),
          builtin: z.boolean(),
        }),
      ),
    }),
  ),
  "tools get": defineOperation(
    "tools get",
    "Inspect one tool",
    z.object({
      item: toolDefinitionSchema.safeExtend({
        hash: z.string(),
        builtin: z.boolean(),
      }),
    }),
    false,
    "required",
  ),
  "tools create": defineOperation(
    "tools create",
    "create tools",
    z.object({
      changed: z.boolean(),
      item: toolDefinitionSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "none",
    false,
  ),
  "tools update": defineOperation(
    "tools update",
    "update tools",
    z.object({
      changed: z.boolean(),
      item: toolDefinitionSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "required",
    false,
  ),
  "tools delete": defineOperation(
    "tools delete",
    "delete tools",
    z.object({
      changed: z.boolean(),
      item: toolDefinitionSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "required",
    true,
  ),
};
const resourceActions: ResourceActions = {
  async read({ registry, action, name }: ResourceContext) {
    const items = [...registry.tools.values()].map((x) => ({
      ...x,
      hash: fingerprint(x),
      builtin: builtinTools.some((t) => t.toolID === x.toolID),
    }));
    if (action === "list") return { items };
    const item = items.find((x) => x.toolID === name) ?? fail("not_found", 404);
    return { item };
  },
  mutate: mutateRegistration,
};
