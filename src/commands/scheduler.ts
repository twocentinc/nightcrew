import { id } from "../engine/contracts.js";
import {
  policyResultSchema,
  schedulerSnapshotSchema,
} from "../engine/scheduler.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { createOperations } from "./definition.js";
import { type ManagementInput } from "./resources.js";

export const operationInputs = {};

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
  if (command === "scheduler explain") return service.explainScheduler();
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "scheduler explain": defineOperation(
    "scheduler explain",
    "Evaluate scheduling policy without dispatching work",
    policyResultSchema.extend({ snapshot: schedulerSnapshotSchema }),
    false,
    "none",
    false,
    "daemon",
  ),
};
