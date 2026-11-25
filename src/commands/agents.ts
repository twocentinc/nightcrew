import { createHash } from "node:crypto";
import { z } from "zod";
import { Service, fail } from "../engine/service.js";
import { agentDraftSchema, agentSchema } from "../schemas/agent.js";
import { id, revision, userMessageSchema } from "../schemas/common.js";
import { configMutation } from "../schemas/config.js";
import { acceptanceSchema } from "../schemas/run.js";
import { createOperations } from "./definition.js";
import {
  resourceCommand,
  type ManagementInput,
  type ResourceActions,
  type ResourceContext,
} from "./resources.js";

export const operationInputs = {
  "agents run": z.strictObject({ message: userMessageSchema }),
  "agents create": z.strictObject({ agent: agentDraftSchema }),
  "agents update": z.strictObject({
    expectedRevision: revision,
    changes: agentSchema
      .omit({ agentID: true, revision: true, createdAt: true, updatedAt: true })
      .partial()
      .extend({
        finishSchema: agentSchema.shape.finishSchema.unwrap().optional(),
        outputValidation: agentSchema.shape.outputValidation
          .unwrap()
          .optional(),
        loopPolicy: agentSchema.shape.loopPolicy.unwrap().optional(),
        compaction: agentSchema.shape.compaction.unwrap().optional(),
        storageLimitMB: agentSchema.shape.storageLimitMB.unwrap().optional(),
        contextMode: z.enum(["fresh", "persistent"]).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        timeSliceMs: z.number().int().min(100).max(3600000).optional(),
        slotID: id.optional(),
        thinking: z.boolean().optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.number().int().min(1).max(32768).optional(),
      }),
  }),
  "agents delete": z.strictObject({ expectedRevision: revision }),
};
const requestSchemas: Record<string, z.ZodType> = operationInputs;
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, resourceID, dryRun = false, yes = false } = input;
  const [] = command.split(" ");
  const name = resourceID === undefined ? undefined : id.parse(resourceID);
  const raw = input.request ?? {};
  if (command === "agents cache clear") {
    service.agent(name ?? fail("missing_id"));
    if (!service.runtime.contextCache)
      fail("cache_management_unavailable", 503);
    if (!yes && !dryRun) fail("confirmation_required");
    return service.runtime.contextCache!(
      "agent-" + createHash("sha256").update(name!).digest("hex"),
      true,
      dryRun,
    );
  }
  if (command === "agents create") {
    const value = requestSchemas[command]!.parse(raw) as {
      agent: z.infer<typeof agentDraftSchema>;
    };
    return service.createAgent(value.agent, dryRun);
  }
  if (command === "agents update") {
    const value = requestSchemas[command]!.parse(raw) as {
      expectedRevision: number;
      changes?: Partial<z.infer<typeof agentSchema>>;
    };
    return service.patchAgent(
      name ?? fail("missing_id"),
      value.expectedRevision,
      value.changes ?? {},
      dryRun,
    );
  }
  if (command === "agents run") {
    const { message } = operationInputs["agents run"].parse(raw);
    return service.submit(name ?? fail("missing_id"), message, false, dryRun);
  }
  return resourceCommand(service, input, requestSchemas, resourceActions);
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "agents list": defineOperation(
    "agents list",
    "List agents",
    z.object({ items: z.array(agentSchema) }),
  ),
  "agents get": defineOperation(
    "agents get",
    "Inspect one agent",
    z.object({
      item: agentSchema,
      cache: z
        .object({
          contextID: z.string(),
          items: z.array(
            z.object({
              modelID: z.string(),
              bytes: z.number().int().nonnegative(),
              updatedAt: z.string(),
            }),
          ),
        })
        .nullable(),
    }),
    false,
    "required",
  ),
  "agents create": defineOperation(
    "agents create",
    "create agents",
    z.object({ agent: agentSchema, changed: z.boolean() }),
    true,
    "none",
    false,
  ),
  "agents update": defineOperation(
    "agents update",
    "update agents",
    z.object({ agent: agentSchema, changed: z.boolean() }),
    true,
    "required",
    false,
  ),
  "agents delete": defineOperation(
    "agents delete",
    "delete agents",
    configMutation,
    true,
    "required",
    true,
  ),
  "agents run": defineOperation(
    "agents run",
    "Submit a fresh managed run",
    acceptanceSchema,
    true,
    "required",
    false,
    "daemon",
  ),
  "agents cache clear": defineOperation(
    "agents cache clear",
    "Discard saved agent KV cache without deleting conversation history",
    z.object({
      contextID: z.string(),
      items: z.array(
        z.object({
          modelID: z.string(),
          bytes: z.number().int().nonnegative(),
          updatedAt: z.string(),
        }),
      ),
      changed: z.boolean(),
    }),
    true,
    "required",
    true,
    "daemon",
  ),
};
const resourceActions: ResourceActions = {
  async read({ service, next, action, name }: ResourceContext) {
    const items = next.agents;
    if (action === "list") return { items };
    const item =
      items.find((x) => x.agentID === name) ?? fail("not_found", 404);
    const cache = await service.runtime.contextCache?.(
      "agent-" + createHash("sha256").update(name!).digest("hex"),
      false,
      false,
    );
    return {
      item,
      cache: cache ? { contextID: cache.contextID, items: cache.items } : null,
    };
  },
  async mutate({ service, next, action, name, value }: ResourceContext) {
    if (action !== "delete") fail("unknown_command");
    const agent = service.agent(name ?? fail("missing_id"));
    if (agent.revision !== value.expectedRevision)
      fail("revision_conflict", 409);
    next.agents = next.agents.filter((a) => a.agentID !== name);
  },
};
