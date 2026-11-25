import { z } from "zod";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { chatDetailSchema, chatInputSchema, id } from "../schemas/common.js";
import { chatAcceptanceSchema } from "../schemas/run.js";
import { createOperations } from "../utils/commands/definition.js";
import { type ManagementInput } from "../utils/commands/resources.js";

export const operationInputs = {
  "instant create": chatInputSchema,
};
const requestSchemas: Record<string, z.ZodType> = operationInputs;
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, resourceID, dryRun = false } = input;
  const [resource, action] = command.split(" ");
  const name = resourceID === undefined ? undefined : id.parse(resourceID);
  const raw = input.request ?? {};
  if (resource === "instant") {
    if (action === "create") {
      if (dryRun)
        return { changed: false, request: requestSchemas[command]!.parse(raw) };
      return service.submitChat(
        requestSchemas[command]!.parse(
          raw,
        ) as import("../schemas/common.js").ChatInput,
      );
    }
    if (action === "get") {
      return service.chatDetail(service.chat(name ?? fail("missing_id")));
    }
    if (action === "delete")
      return service.deleteChat(name ?? fail("missing_id"), dryRun);
  }
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "instant create": defineOperation(
    "instant create",
    "Submit instant inference; execute selected skill reads and return client tool calls",
    z.union([
      chatAcceptanceSchema,
      z.object({ changed: z.literal(false), request: chatInputSchema }),
    ]),
    true,
    "none",
    false,
    "daemon",
  ),
  "instant get": defineOperation(
    "instant get",
    "Inspect an instant inference request",
    chatDetailSchema,
    false,
    "required",
    false,
    "daemon",
  ),
  "instant delete": defineOperation(
    "instant delete",
    "Cancel and discard an instant request and its transient result",
    z.object({
      requestID: z.string(),
      status: z.string(),
      changed: z.boolean(),
    }),
    true,
    "required",
    false,
    "daemon",
  ),
};
