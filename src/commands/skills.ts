import { loadSkillContent } from "../engine/capabilities/skills.js";
import { z } from "zod";
import { Service, fail } from "../engine/service.js";
import {
  skillLoadInputSchema,
  skillLoadResultSchema,
  skillSchema,
  skillMetadataSchema,
} from "../schemas/agent.js";
import { id } from "../schemas/common.js";
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
  "skills read": skillLoadInputSchema.extend({ runID: id.optional() }),
  "skills create": z.strictObject({ skill: skillSchema }),
  "skills update": z.strictObject({
    expectedHash: z.string(),
    changes: z.strictObject({...skillSchema.shape}).omit({skillID: true}).partial().extend({
      files: skillSchema.shape.files.removeDefault().optional(),
    }),
  }),
  "skills delete": z.strictObject({ expectedHash: z.string() }),
};
const requestSchemas: Record<string, z.ZodType> = operationInputs;
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command } = input;
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
    z.object({ items: z.array(skillMetadataSchema.extend({ hash: z.string() })) }),
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
  async read({ registry, action, name }: ResourceContext) {
    const items = [...registry.skills.values()].map((x) => ({
      ...x,
      hash: fingerprint(x),
    }));
    if (action === "list") return { items: items.map(({ skillID, name, description, hash }) => ({ skillID, name, description, hash })) };
    const item =
      items.find((x) => x.skillID === name) ?? fail("not_found", 404);
    return { item };
  },
  mutate: mutateRegistration,
};
