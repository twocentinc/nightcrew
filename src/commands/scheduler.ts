import {
  policyResultSchema,
  schedulerSnapshotSchema,
} from "../engine/scheduling/policy.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { createOperations } from "../utils/commands/definition.js";
import { type ManagementInput } from "../utils/commands/resources.js";

export const operationInputs = {};
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command } = input;
  const [] = command.split(" ");
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
