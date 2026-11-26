import { fail, type Service } from "../../engine/service.js";
import { handle as agents } from "../../commands/agents.js";
import { handle as config } from "../../commands/config.js";
import { handle as evals } from "../../commands/evals.js";
import { handle as instant } from "../../commands/instant.js";
import { handle as models } from "../../commands/models.js";
import type { ManagementInput } from "./resources.js";
import { handle as runs } from "../../commands/runs.js";
import { handle as skills } from "../../commands/skills.js";
import { handle as statusCommands } from "../../commands/status.js";
import { handle as tools } from "../../commands/tools.js";
import { handle as triggers } from "../../commands/triggers.js";

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
