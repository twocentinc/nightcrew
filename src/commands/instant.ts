import { z } from "zod";
import {
  chatAcceptanceSchema,
  chatDetailSchema,
  chatInputSchema,
  id,
} from "../engine/contracts.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { createOperations } from "./definition.js";
import { type ManagementInput } from "./resources.js";

export const operationInputs = {
  "instant submit": chatInputSchema,
  "instant unload": z.strictObject({}),
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
  if (resource === "instant") {
    if (action === "unload") return service.unloadInstant(dryRun);
    if (action === "submit") {
      if (dryRun)
        return { changed: false, request: requestSchemas[command]!.parse(raw) };
      return service.submitChat(
        requestSchemas[command]!.parse(
          raw,
        ) as import("../engine/contracts.js").ChatInput,
      );
    }
    if (action === "get") {
      return service.chatDetail(service.chat(name ?? fail("missing_id")));
    }
    if (action === "cancel")
      return service.cancelChat(name ?? fail("missing_id"), dryRun);
  }
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "instant submit": defineOperation(
    "instant submit",
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
  "instant unload": defineOperation(
    "instant unload",
    "Stop instant work and unload its model, ignoring keep-warm; refuse unrelated model work",
    z.object({
      modelID: z.string(),
      changed: z.boolean(),
      cancelledRunIDs: z.array(z.string()),
      cancelledRequestIDs: z.array(z.string()),
    }),
    true,
    "none",
    false,
    "daemon",
  ),
  "instant cancel": defineOperation(
    "instant cancel",
    "Cancel instant inference",
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
