import { schedulerSnapshotSchema, policyResultSchema, schedulerStatusSchema } from "./scheduler.js";
import { z } from "zod";
import {
  os,
  createRouterClient,
  ORPCError,
  type AnyProcedure,
  type InferSchemaInput,
} from "@orpc/server";
import { timingSafeEqual } from "node:crypto";
import { requestSchemas, operationInputs } from "./operationInputs.js";
import { manage, type ManagementInput } from "./management.js";
import type { Service } from "./service.js";
import { tokenHash } from "./storage.js";
import { Execution, currentExecution } from "./execution.js";
import { NightcrewError } from "./protocol.js";
import {
  triggerSchema,
  agentSchema,
  modelSchema,
  skillSchema,
  skillLoadResultSchema,
  configSchema,
  runSummarySchema,
  runDetailSchema,
  transcriptEntrySchema,
  acceptanceSchema,
  chatAcceptanceSchema,
  chatInputSchema,
  chatDetailSchema,
  statusSchema,
  searchMatchSchema,
} from "./contracts.js";
import { toolDefinitionSchema } from "./registry.js";

const empty = z.strictObject({});
const changed = z.object({ changed: z.boolean() });
const adminConfig = configSchema.omit({ rootTokenHash: true });
const configMutation = z.object({
  changed: z.boolean(),
  restartRequired: z.boolean(),
  config: adminConfig,
  agentID: z.string().optional(),
});
export type OperationContext = {
  service: Service;
  local?: boolean;
  request?: { headers: { authorization?: string } };
};
function procedure<I extends z.ZodType, O extends z.ZodType>(
  name: string,
  input: I,
  output: O,
  operand: string,
  mutates: boolean,
  confirmation: boolean,
  localOnly: boolean,
) {
  return os
    .$context<OperationContext>()
    .use(async ({ context, next }) => {
      if (!context.local) {
        const header = context.request?.headers.authorization;
        if (
          !header?.startsWith("Bearer ") ||
          !timingSafeEqual(
            Buffer.from(tokenHash(header.slice(7)), "hex"),
            Buffer.from(
              context.service.storage.store.config.rootTokenHash,
              "hex",
            ),
          )
        )
          throw new ORPCError("UNAUTHORIZED");
        if (localOnly)
          throw new ORPCError("FORBIDDEN", {
            message: "This operation requires local filesystem access",
          });
      }
      return next();
    })
    .route({
      method: "POST",
      path: `/v1/operations/${name.replaceAll(" ", "/")}`,
      summary: name,
    })
    .input(
      z.strictObject({
        resourceID:
          operand === "required"
            ? z.string().min(1).max(1000)
            : z.never().optional(),
        request: input,
        dryRun: z.boolean().default(false),
        yes: z.boolean().default(false),
      }),
    )
    .output(output)
    .handler(async ({ input: value, context }) => {
      if (confirmation && !value.yes && !value.dryRun)
        throw new ORPCError("BAD_REQUEST", {
          message: "confirmation_required",
        });
      const invoke = async () => {
        const result = await manage(context.service, {
          command: name,
          ...value,
        });
        const parsed = output.safeParse(result);
        if (!parsed.success)
          throw new NightcrewError(
            "protocol.invalidResult",
            "Operation result does not match its contract",
            1,
          );
        return parsed.data as InferSchemaInput<O>;
      };
      return currentExecution()
        ? invoke()
        : new Execution(90000, mutates && !value.dryRun).run(invoke);
    });
}
export type OperationDefinition = {
  name: string;
  description: string;
  scope: "management" | "daemon";
  operand: "none" | "required";
  mutates: boolean;
  confirmation: boolean;
  options: string[];
  request: z.ZodType;
  result: z.ZodType;
  localOnly: boolean;
  procedure: ReturnType<typeof procedure>;
};
const triggerInfo = triggerSchema.extend({
  nextFireAt: z.string().nullable(),
  automaticDispatchEnabled: z.boolean(),
  blockers: z.array(z.string()),
});

function inputFor<N extends string>(
  name: N,
): N extends keyof typeof operationInputs
  ? (typeof operationInputs)[N]
  : typeof empty {
  return (requestSchemas[name] ??
    empty) as N extends keyof typeof operationInputs
    ? (typeof operationInputs)[N]
    : typeof empty;
}
function defineOperation<N extends string, O extends z.ZodType>(
  name: N,
  description: string,
  result: O,
  mutates = false,
  operand: "none" | "required" = "none",
  confirmation = false,
  scope: "management" | "daemon" = "management",
  options: string[] = [],
) {
  const request = inputFor(name);
  const localOnly = ["runs export", "runs verify"].includes(name);
  const proc = procedure(
    name,
    request,
    result,
    operand,
    mutates,
    confirmation,
    localOnly,
  );
  return {
    name,
    description,
    scope,
    operand,
    mutates,
    confirmation,
    options,
    request: proc["~orpc"].inputSchema!.shape.request,
    result: proc["~orpc"].outputSchema!,
    localOnly,
    procedure: proc,
  };
}
export const operations = {
  "runs review": defineOperation(
    "runs review",
    "Acknowledge, resolve or reopen a run review with a durable note",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "runs resume": defineOperation(
    "runs resume",
    "Explicitly release a paused or held run",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "runs retry": defineOperation(
    "runs retry",
    "Retry the last input in the same transcript with a new message UUID",
    acceptanceSchema,
    true,
    "required",
    true,
    "daemon",
  ),
  "runs retry-hook": defineOperation(
    "runs retry-hook",
    "Explicitly retry a failed hook with a durable attempt and request UUID",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    true,
    "daemon",
  ),
  "auth rotate": defineOperation(
    "auth rotate",
    "Replace the HTTP root token and return it once",
    changed.extend({ token: z.string().optional() }),
    true,
    "none",
    true,
  ),
  "fleet status": defineOperation(
    "fleet status",
    "Inspect agents, schedules, recent outcomes and runs needing review",
    z.object({
      observedAt: z.string(),
      runtime: statusSchema,
      totals: z.object({
        runs: z.number(),
        needsReview: z.number(),
        activeMs: z.number(),
      }),
      agents: z.array(
        z.object({
          agentID: z.string(),
          name: z.string(),
          enabled: z.boolean(),
          modelID: z.string(),
          latestRun: runSummarySchema.nullable(),
          activeRuns: z.number(),
          needsReview: z.number(),
          activeMs: z.number(),
          triggers: z.array(triggerInfo),
        }),
      ),
      review: z.array(runSummarySchema),
      reviewTruncated: z.boolean(),
    }),
    false,
    "none",
    false,
    "daemon",
  ),
  "daemon status": defineOperation(
    "daemon status",
    "Inspect current daemon and scheduler state",
    statusSchema.extend({ pid: z.number() }),
    false,
    "none",
    false,
    "daemon",
  ),
  "presence status": defineOperation(
    "presence status",
    "Inspect presence and interaction cooldown",
    statusSchema.pick({ presence: true, cooldownUntil: true }),
    false,
    "none",
    false,
    "daemon",
  ),
  "config get": defineOperation(
    "config get",
    "Read redacted configuration",
    z.object({ config: adminConfig }),
  ),
  "config update": defineOperation(
    "config update",
    "Apply revision-checked configuration changes",
    configMutation,
    true,
  ),
  "agents list": defineOperation(
    "agents list",
    "List agents",
    z.object({ items: z.array(agentSchema) }),
  ),
  "agents get": defineOperation(
    "agents get",
    "Inspect one agent",
    z.object({ item: agentSchema }),
    false,
    "required",
  ),
  "agents create": defineOperation(
    "agents create",
    "create agents",
    z.object({ agent: agentSchema, changed: z.boolean() }),
    true,
    "none",
    false,
  ),
  "agents update": defineOperation(
    "agents update",
    "update agents",
    z.object({ agent: agentSchema, changed: z.boolean() }),
    true,
    "required",
    false,
  ),
  "agents delete": defineOperation(
    "agents delete",
    "delete agents",
    configMutation,
    true,
    "required",
    true,
  ),
  "models list": defineOperation(
    "models list",
    "List models",
    z.object({ items: z.array(modelSchema) }),
  ),
  "models get": defineOperation(
    "models get",
    "Inspect one model",
    z.object({ item: modelSchema }),
    false,
    "required",
  ),
  "models create": defineOperation(
    "models create",
    "create models",
    configMutation,
    true,
    "none",
    false,
  ),
  "models update": defineOperation(
    "models update",
    "update models",
    configMutation,
    true,
    "required",
    false,
  ),
  "models delete": defineOperation(
    "models delete",
    "delete models",
    configMutation,
    true,
    "required",
    true,
  ),
  "skills reload": defineOperation(
    "skills reload",
    "Reload skill folders and tool definitions",
    z.object({
      changed: z.boolean(),
      skills: z.number().int(),
      tools: z.number().int(),
    }),
    true,
  ),
  "skills read": defineOperation(
    "skills read",
    "Read skill instructions and supporting files on demand",
    skillLoadResultSchema,
  ),
  "skills list": defineOperation(
    "skills list",
    "List skills",
    z.object({ items: z.array(skillSchema.safeExtend({ hash: z.string() })) }),
  ),
  "skills get": defineOperation(
    "skills get",
    "Inspect one skill",
    z.object({ item: skillSchema.safeExtend({ hash: z.string() }) }),
    false,
    "required",
  ),
  "skills create": defineOperation(
    "skills create",
    "create skills",
    z.object({
      changed: z.boolean(),
      item: skillSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "none",
    false,
  ),
  "skills update": defineOperation(
    "skills update",
    "update skills",
    z.object({
      changed: z.boolean(),
      item: skillSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "required",
    false,
  ),
  "skills delete": defineOperation(
    "skills delete",
    "delete skills",
    z.object({
      changed: z.boolean(),
      item: skillSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "required",
    true,
  ),
  "tools list": defineOperation(
    "tools list",
    "List tools",
    z.object({
      items: z.array(
        toolDefinitionSchema.safeExtend({
          hash: z.string(),
          builtin: z.boolean(),
        }),
      ),
    }),
  ),
  "tools get": defineOperation(
    "tools get",
    "Inspect one tool",
    z.object({
      item: toolDefinitionSchema.safeExtend({
        hash: z.string(),
        builtin: z.boolean(),
      }),
    }),
    false,
    "required",
  ),
  "tools create": defineOperation(
    "tools create",
    "create tools",
    z.object({
      changed: z.boolean(),
      item: toolDefinitionSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "none",
    false,
  ),
  "tools update": defineOperation(
    "tools update",
    "update tools",
    z.object({
      changed: z.boolean(),
      item: toolDefinitionSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "required",
    false,
  ),
  "tools delete": defineOperation(
    "tools delete",
    "delete tools",
    z.object({
      changed: z.boolean(),
      item: toolDefinitionSchema.safeExtend({ hash: z.string() }).nullable(),
    }),
    true,
    "required",
    true,
  ),
  "agents enable": defineOperation(
    "agents enable",
    "enable automatic agent eligibility",
    z.object({ agent: agentSchema, changed: z.boolean() }),
    true,
    "required",
  ),
  "agents disable": defineOperation(
    "agents disable",
    "disable automatic agent eligibility",
    z.object({ agent: agentSchema, changed: z.boolean() }),
    true,
    "required",
  ),
  "triggers list": defineOperation(
    "triggers list",
    "Inspect triggers and future schedule occurrences",
    z.object({ items: z.array(triggerInfo) }),
  ),
  "triggers get": defineOperation(
    "triggers get",
    "Inspect a trigger, next occurrence and admission blockers",
    z.object({ item: triggerInfo }),
    false,
    "required",
  ),
  "triggers create": defineOperation(
    "triggers create",
    "create a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "none",
    false,
  ),
  "triggers update": defineOperation(
    "triggers update",
    "update a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "required",
    false,
  ),
  "triggers delete": defineOperation(
    "triggers delete",
    "delete a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "required",
    true,
  ),
  "triggers enable": defineOperation(
    "triggers enable",
    "enable a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "required",
    false,
  ),
  "triggers disable": defineOperation(
    "triggers disable",
    "disable a saved trigger",
    z.object({ item: triggerSchema.nullable(), changed: z.boolean() }),
    true,
    "required",
    false,
  ),
  "triggers fire": defineOperation(
    "triggers fire",
    "Manually submit a saved trigger without changing its schedule",
    z.object({
      outcome: z.enum(["queued", "coalesced", "skipped", "replayed"]),
      runID: z.string(),
      occurrenceID: z.uuid(),
      changed: z.boolean(),
    }),
    true,
    "required",
    false,
    "daemon",
  ),
  "queue list": defineOperation(
    "queue list",
    "List queued and paused runs, including held work",
    z.object({
      items: z.array(runSummarySchema),
      nextCursor: z.string().nullable(),
    }),
    false,
    "none",
    false,
    "daemon",
    ["limit", "cursor", "agent", "state"],
  ),
  "queue get": defineOperation(
    "queue get",
    "Inspect a pending run and its trigger snapshot",
    z.object({ run: runDetailSchema }),
    false,
    "required",
    false,
    "daemon",
  ),
  "queue hold": defineOperation(
    "queue hold",
    "hold a pending run with a revision check",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "queue release": defineOperation(
    "queue release",
    "release a pending run with a revision check",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "queue cancel": defineOperation(
    "queue cancel",
    "cancel a pending run with a revision check",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "agents run": defineOperation(
    "agents run",
    "Submit a fresh managed run",
    acceptanceSchema,
    true,
    "required",
    false,
    "daemon",
  ),
  "runs list": defineOperation(
    "runs list",
    "List durable run summaries",
    z.object({
      items: z.array(runSummarySchema),
      nextCursor: z.string().nullable(),
    }),
    false,
    "none",
    false,
    "management",
    ["limit", "cursor", "agent", "state"],
  ),
  "runs get": defineOperation(
    "runs get",
    "Inspect a durable run",
    z.object({ run: runDetailSchema }),
    false,
    "required",
    false,
    "management",
  ),
  "runs transcript": defineOperation(
    "runs transcript",
    "Read committed run evidence",
    z.object({
      items: z.array(transcriptEntrySchema),
      nextCursor: z.string().nullable(),
    }),
    false,
    "required",
    false,
    "management",
    ["limit", "cursor"],
  ),
  "runs search": defineOperation(
    "runs search",
    "Search saved messages, attachments and results with bounded excerpts",
    z.object({
      items: z.array(searchMatchSchema),
      nextCursor: z.string().nullable(),
    }),
    false,
    "required",
    false,
    "daemon",
    ["limit", "cursor", "agent", "state"],
  ),
  "runs export": defineOperation(
    "runs export",
    "Export a committed run snapshot and checksum manifest to a new directory",
    z.object({
      runID: z.string(),
      destination: z.string(),
      changed: z.boolean(),
      revision: z.number(),
      lastEventSequence: z.number(),
    }),
    true,
    "required",
    false,
    "management",
  ),
  "runs verify": defineOperation(
    "runs verify",
    "Validate saved run integrity or an exported bundle without modifying it",
    z.object({
      runID: z.string(),
      valid: z.boolean(),
      checks: z.array(z.string()),
      errors: z.array(z.string()),
      revision: z.number().nullable(),
      lastEventSequence: z.number().nullable(),
    }),
    false,
    "required",
    false,
    "management",
  ),
  "runs reply": defineOperation(
    "runs reply",
    "Submit a continuation",
    acceptanceSchema,
    true,
    "required",
    false,
    "daemon",
  ),
  "runs cancel": defineOperation(
    "runs cancel",
    "Cancel managed work",
    z.object({ runID: z.string(), status: z.string(), changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "agents cache": defineOperation(
    "agents cache",
    "Inspect saved agent KV cache without changing its transcript",
    z.object({contextID:z.string(),items:z.array(z.object({modelID:z.string(),bytes:z.number().int().nonnegative(),updatedAt:z.string()})),changed:z.boolean()}),
    false,
    "required",
    false,
    "daemon",
  ),
  "agents reset-cache": defineOperation(
    "agents reset-cache",
    "Discard saved agent KV cache without deleting conversation history",
    z.object({contextID:z.string(),items:z.array(z.object({modelID:z.string(),bytes:z.number().int().nonnegative(),updatedAt:z.string()})),changed:z.boolean()}),
    true,
    "required",
    true,
    "daemon",
  ),
  "scheduler get": defineOperation(
    "scheduler get",
    "Inspect scheduler settings",
    z.object({
      configRevision: z.number(),
      settings: configSchema.shape.scheduler,
    }),
  ),
  "scheduler update": defineOperation(
    "scheduler update",
    "Configure capacity, residency, timers and policy hook",
    z.object({
      changed: z.boolean(),
      configRevision: z.number(),
      settings: configSchema.shape.scheduler,
    }),
    true,
  ),
  "scheduler status": defineOperation(
    "scheduler status",
    "Inspect active allocations and the last scheduling decision",
    schedulerStatusSchema,
    false,
    "none",
    false,
    "daemon",
  ),
  "scheduler explain": defineOperation(
    "scheduler explain",
    "Evaluate scheduling policy without dispatching work",
    policyResultSchema.extend({snapshot:schedulerSnapshotSchema}),
    false,
    "none",
    false,
    "daemon",
  ),
  "evals release": defineOperation(
    "evals release", "Release a terminal eval sample after saving its result",
    z.object({ changed: z.boolean() }), true, "required", false, "daemon",
  ),
  "evals sample": defineOperation(
    "evals sample", "Generate one eval turn; return all tool calls without executing any",
    z.union([chatAcceptanceSchema, z.object({ changed: z.literal(false), request: operationInputs["evals sample"] })]),
    true, "none", false, "daemon",
  ),
  "inference submit": defineOperation(
    "inference submit",
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
  "inference get": defineOperation(
    "inference get",
    "Inspect an instant inference request",
    chatDetailSchema,
    false,
    "required",
    false,
    "daemon",
  ),
  "inference cancel": defineOperation(
    "inference cancel",
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
export const operationDefinitions = Object.values(operations);
export const getOperation = (name: string) =>
  operationDefinitions.find((d) => d.name === name);
export const operationRouter = Object.fromEntries(
  operationDefinitions.map((d) => [d.name, d.procedure]),
) as { [K in keyof typeof operations]: (typeof operations)[K]["procedure"] };
export const httpOperationRouter = Object.fromEntries(
  operationDefinitions
    .filter((d) => !d.localOnly)
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
