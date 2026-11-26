import { z } from "zod";
import {
  evalSchema,
  normalizeEval,
  overrideSchema,
  graderSchema,
  evalRecordSchema,
  authorMessage,
  toolOverrideSchema,
} from "../engine/evals/format.js";
import { editTools, editTranscript } from "../engine/evals/definitions.js";
import { EvalStore } from "../storage/evals.js";
import { id, uuid } from "../schemas/common.js";
import { acceptanceSchema } from "../schemas/run.js";
import { createOperations } from "../utils/commands/definition.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/protocol.js";
import type { ManagementInput } from "../utils/commands/resources.js";
const revision = { expectedRevision: z.number().int().positive().optional() };
export const operationInputs = {
  "evals create": z.strictObject({ eval: evalSchema }),
  "evals update": z.strictObject({
    ...revision,
    changes: z.strictObject({
      agentID: id.optional(),
      overrides: overrideSchema.optional(),
      messages: z.array(authorMessage).max(1000).optional(),
      tools: z.array(toolOverrideSchema).max(1000).optional(),
      grader: graderSchema.nullish(),
    }),
  }),
  "evals delete": z.strictObject(revision),
  "evals tools set": toolOverrideSchema.extend(revision),
  "evals tools delete": z.strictObject({
    ...revision,
    toolID: id,
    input: z.record(z.string(), z.json()).optional(),
  }),
  "evals transcript set": z.strictObject({
    ...revision,
    messages: z.array(authorMessage).max(1000),
  }),
  "evals transcript append": z.strictObject({
    ...revision,
    messages: z.array(authorMessage).min(1).max(1000),
  }),
  "evals transcript update": z.strictObject({
    ...revision,
    messageID: uuid,
    message: authorMessage,
  }),
  "evals transcript delete": z.strictObject({ ...revision, messageID: uuid }),
};
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, resourceID, dryRun = false } = input;
  const store = new EvalStore(service.storage.home);
  if (command === "evals list") return { items: await store.list() };
  const raw = input.request ?? {};
  if (command === "evals create")
    return service.storage.exclusive(async () => {
      const definition = normalizeEval(
        operationInputs["evals create"].parse(raw).eval,
      );
      const existing = await store.get(definition.evalID).catch((error) => {
        if (error.message === "eval_not_found") return null;
        throw error;
      });
      if (existing) fail("eval_exists", 409);
      if (!dryRun) await store.save(definition, 1);
      return { item: { definition, revision: 1 }, changed: !dryRun };
    });
  const evalID = id.parse(resourceID);
  if (command === "evals run") {
    const record = await store.get(evalID);
    return service.submitEval(record.definition, record.revision, dryRun);
  }
  if (
    ["evals get", "evals tools list", "evals transcript get"].includes(command)
  ) {
    const record = await store.get(evalID);
    return command === "evals get"
      ? { item: record }
      : command === "evals tools list"
        ? { items: record.definition.tools, revision: record.revision }
        : { messages: record.definition.messages, revision: record.revision };
  }
  return service.storage.exclusive(async () => {
    const record = await store.get(evalID);
    const request = (operationInputs as Record<string, z.ZodType>)[
      command
    ]?.parse(raw) as Record<string, unknown> | undefined;
    if (!request) fail("unknown_command");
    if (
      request.expectedRevision !== undefined &&
      request.expectedRevision !== record.revision
    )
      fail("revision_conflict", 409);
    if (command === "evals delete") {
      if (!dryRun) await store.delete(evalID);
      return { changed: !dryRun };
    }
    let definition = structuredClone(record.definition);
    if (command === "evals update")
      definition = normalizeEval({
        ...definition,
        ...(request.changes as object),
      });
    else if (command.startsWith("evals tools "))
      definition = editTools(
        definition,
        command.endsWith("set") ? "set" : "delete",
        request as Parameters<typeof editTools>[2],
      );
    else
      definition = editTranscript(
        definition,
        command.split(" ").at(-1)!,
        request,
      );
    const item = { definition, revision: record.revision + 1 };
    if (!dryRun) await store.save(definition, item.revision);
    return { item, changed: !dryRun };
  });
}
const define = createOperations(operationInputs, handle);
const mutation = z.strictObject({
  item: evalRecordSchema,
  changed: z.boolean(),
});
export const operations = {
  "evals list": define(
    "evals list",
    "List saved eval definitions",
    z.strictObject({ items: z.array(evalRecordSchema) }),
  ),
  "evals get": define(
    "evals get",
    "Read an eval definition",
    z.strictObject({ item: evalRecordSchema }),
    false,
    "required",
  ),
  "evals create": define(
    "evals create",
    "Create an eval definition",
    mutation,
    true,
    "none",
    false,
    "management",
    { file: { field: "eval", input: "json" } },
  ),
  "evals update": define(
    "evals update",
    "Update eval parameters",
    mutation,
    true,
    "required",
  ),
  "evals delete": define(
    "evals delete",
    "Delete an eval definition; retain its runs",
    z.strictObject({ changed: z.boolean() }),
    true,
    "required",
    true,
  ),
  "evals run": define(
    "evals run",
    "Submit an ordinary run with eval tool overrides and grading",
    acceptanceSchema,
    true,
    "required",
    false,
    "daemon",
  ),
  "evals tools list": define(
    "evals tools list",
    "List exact and default tool responses",
    z.strictObject({
      items: z.array(toolOverrideSchema),
      revision: z.number().int(),
    }),
    false,
    "required",
  ),
  "evals tools set": define(
    "evals tools set",
    "Set an exact or default tool response",
    mutation,
    true,
    "required",
    false,
    "management",
    {
      tool: { field: "toolID" },
      input: { field: "input", input: "json" },
      output: { field: "output", input: "json" },
    },
  ),
  "evals tools delete": define(
    "evals tools delete",
    "Delete an exact or default tool response",
    mutation,
    true,
    "required",
    false,
    "management",
    { tool: { field: "toolID" }, input: { field: "input", input: "json" } },
  ),
  "evals transcript get": define(
    "evals transcript get",
    "Read the starting transcript",
    z.strictObject({
      messages: z.array(authorMessage),
      revision: z.number().int(),
    }),
    false,
    "required",
  ),
  "evals transcript set": define(
    "evals transcript set",
    "Replace the starting transcript",
    mutation,
    true,
    "required",
    false,
    "management",
    { file: { field: "messages", input: "messages" } },
  ),
  "evals transcript append": define(
    "evals transcript append",
    "Append messages to the starting transcript",
    mutation,
    true,
    "required",
    false,
    "management",
    { file: { field: "messages", input: "messages" } },
  ),
  "evals transcript update": define(
    "evals transcript update",
    "Replace a starting message by UUID",
    mutation,
    true,
    "required",
    false,
    "management",
    {
      file: { field: "message", input: "json" },
      message: { field: "messageID" },
    },
  ),
  "evals transcript delete": define(
    "evals transcript delete",
    "Delete a message and its paired tool results",
    mutation,
    true,
    "required",
    false,
    "management",
    { message: { field: "messageID" } },
  ),
};
