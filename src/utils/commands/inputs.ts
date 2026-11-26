import { z } from "zod";
import { operationInputs as agents } from "../../commands/agents.js";
import { operationInputs as config } from "../../commands/config.js";
import { operationInputs as evals } from "../../commands/evals.js";
import { operationInputs as init } from "../../commands/init.js";
import { operationInputs as instant } from "../../commands/instant.js";
import { operationInputs as models } from "../../commands/models.js";
import { operationInputs as runs } from "../../commands/runs.js";
import { operationInputs as skills } from "../../commands/skills.js";
import { operationInputs as statusCommands } from "../../commands/status.js";
import { operationInputs as tools } from "../../commands/tools.js";
import { operationInputs as triggers } from "../../commands/triggers.js";

export const operationInputs = {
  ...statusCommands,
  ...evals,
  ...runs,
  ...agents,
  ...instant,
  ...triggers,
  ...init,
  ...config,
  ...models,
  ...skills,
  ...tools,
};
export const requestSchemas: Record<string, z.ZodType> = operationInputs;
