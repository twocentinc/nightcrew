import { z } from "zod";
import {
  id,
  skillLoadInputSchema,
  skillLoadResultSchema,
  skillSchema,
} from "../engine/contracts.js";
import { Service, fail } from "../engine/service.js";
import { loadSkillContent } from "../engine/skills.js";
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
  "skills read": skillLoadInputSchema.extend({ runID: id.optional() }),
  "skills create": z.strictObject({ skill: skillSchema }),
  "skills update": z.strictObject({
    expectedHash: z.string(),
    skill: z.strictObject({
      ...skillSchema.shape,
      files: skillSchema.shape.files.unwrap().optional(),
    }),
  }),
  "skills delete": z.strictObject({ expectedHash: z.string() }),
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
  if (command === "skills read") {
    const request = requestSchemas[command]!.parse(raw) as { runID?: string };
    if (request.runID) await service.storage.reconcile();
    const skills = request.runID
      ? (await service.run(request.runID)).skills
      : [...service.skills.values()];
    const { runID, ...selection } = request;
    return loadSkillContent(skills, selection);
  }
  return resourceCommand(service, input, requestSchemas, resourceActions);
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "skills read": defineOperation(
    "skills read",
    "Read skill instructions and supporting files on demand",
    skillLoadResultSchema,
  ),
  "skills list": defineOperation(
    "skills list",
    "List skills",
    z.object({ items: z.array(skillSchema.safeExtend({ hash: z.string() })) }),
  ),
  "skills get": defineOperation(
    "skills get",
    "Inspect one skill",
    z.object({ item: skillSchema.safeExtend({ hash: z.string() }) }),
    false,
    "required",
  ),
  "skills create": defineOperation(
    "skills create",
    "create skills",
    z.object({
      changed: z.boolean(),
      item: skillSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "none",
    false,
  ),
  "skills update": defineOperation(
    "skills update",
    "update skills",
    z.object({
      changed: z.boolean(),
      item: skillSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "required",
    false,
  ),
  "skills delete": defineOperation(
    "skills delete",
    "delete skills",
    z.object({
      changed: z.boolean(),
      item: skillSchema.safeExtend({ hash: z.string() }).nullable(),
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
    const items = [...registry.skills.values()].map((x) => ({
      ...x,
      hash: fingerprint(x),
    }));
    if (action === "list") return { items };
    const item =
      items.find((x) => x.skillID === name) ?? fail("not_found", 404);
    return { item };
  },
  mutate: mutateRegistration,
};
