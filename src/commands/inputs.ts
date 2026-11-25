import { z } from "zod";
import { operationInputs as agents } from "./agents.js";
import { operationInputs as config } from "./config.js";
import { operationInputs as evals } from "./evals.js";
import { operationInputs as init } from "./init.js";
import { operationInputs as instant } from "./instant.js";
import { operationInputs as models } from "./models.js";
import { operationInputs as runs } from "./runs.js";
import { operationInputs as scheduler } from "./scheduler.js";
import { operationInputs as skills } from "./skills.js";
import { operationInputs as statusCommands } from "./status.js";
import { operationInputs as tools } from "./tools.js";
import { operationInputs as triggers } from "./triggers.js";

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
  ...scheduler,
};
export const requestSchemas: Record<string, z.ZodType> = operationInputs;
