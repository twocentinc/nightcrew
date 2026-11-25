import { z } from "zod";
import { id } from "../engine/contracts.js";
import { builtinTools, toolDefinitionSchema } from "../engine/registry.js";
import { Service, fail } from "../engine/service.js";
import { createOperations } from "./definition.js";
import {
  fingerprint,
  mutateRegistration,
  resourceCommand,
  type ManagementInput,
  type ResourceActions,
  type ResourceContext,
} from "./resources.js";

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
