import { fail, type Service } from "../engine/service.js";
import { handle as agents } from "./agents.js";
import { handle as config } from "./config.js";
import { handle as evals } from "./evals.js";
import { handle as instant } from "./instant.js";
import { handle as models } from "./models.js";
import type { ManagementInput } from "./resources.js";
import { handle as runs } from "./runs.js";
import { handle as scheduler } from "./scheduler.js";
import { handle as skills } from "./skills.js";
import { handle as statusCommands } from "./status.js";
import { handle as tools } from "./tools.js";
import { handle as triggers } from "./triggers.js";

export { type ManagementInput } from "./resources.js";

const handlers: Record<
  string,
  (service: Service, input: ManagementInput) => Promise<unknown>
> = {
  status: statusCommands,
  evals: evals,
  runs: runs,
  agents: agents,
  instant: instant,
  triggers: triggers,
  config: config,
  models: models,
  skills: skills,
  tools: tools,
  scheduler: scheduler,
};
export function manage(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  return (handlers[input.command.split(" ")[0]!] ?? fail("unknown_command"))(
    service,
    input,
  );
}
