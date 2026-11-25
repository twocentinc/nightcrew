import { createRouterClient, type AnyProcedure } from "@orpc/server";
import { NightcrewError } from "../../engine/protocol.js";
import type { Service } from "../../engine/service.js";
import { operations as agents } from "../../commands/agents.js";
import { operations as config } from "../../commands/config.js";
import { operations as evals } from "../../commands/evals.js";
import { operations as init } from "../../commands/init.js";
import { operations as instant } from "../../commands/instant.js";
import { type ManagementInput } from "./management.js";
import { operations as models } from "../../commands/models.js";
import { operations as runs } from "../../commands/runs.js";
import { operations as scheduler } from "../../commands/scheduler.js";
import { operations as skills } from "../../commands/skills.js";
import { operations as statusCommands } from "../../commands/status.js";
import { operations as tools } from "../../commands/tools.js";
import { operations as triggers } from "../../commands/triggers.js";

export const operations = {
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
export const operationDefinitions = Object.values(operations);
export const getOperation = (name: string) =>
  operationDefinitions.find((d) => d.name === name);
export const operationRouter = Object.fromEntries(
  operationDefinitions.map((d) => [d.name, d.procedure]),
) as { [K in keyof typeof operations]: (typeof operations)[K]["procedure"] };
export const httpOperationRouter = Object.fromEntries(
  operationDefinitions
    .filter(
      (d) =>
        !d.localOnly && !["evals sample", "evals release"].includes(d.name),
    )
    .map((d) => [d.name, d.procedure]),
);
export type ManagementRouter = typeof operationRouter;
export async function callOperation(service: Service, input: ManagementInput) {
  const definition = getOperation(input.command);
  if (!definition)
    throw new NightcrewError(
      "cli.invalidCommand",
      "Unknown management operation",
      2,
    );
  // The dynamic CLI dispatch boundary is validated by this exact oRPC procedure.
  const dynamic: AnyProcedure = definition.procedure;
  const client = createRouterClient(
    { operation: dynamic },
    { context: { service, local: true } },
  );
  return client.operation({
    resourceID: input.resourceID,
    request: input.request ?? {},
    dryRun: input.dryRun ?? false,
    yes: input.yes ?? false,
  });
}

export const managementClient = (service: Service) =>
  createRouterClient(operationRouter, { context: { service, local: true } });

export type { OperationContext, OperationDefinition } from "./definition.js";
