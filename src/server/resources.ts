import { eventIterator } from "@orpc/server";
import { z } from "zod";
import { operationInputs } from "../utils/commands/inputs.js";
import {
  httpOperationRouter,
  managementClient,
} from "../utils/commands/operations.js";
import { packageVersion } from "../engine/protocol.js";
import { Service } from "../engine/service.js";
import {
  agentDraftSchema,
  agentSchema,
  skillSchema,
} from "../schemas/agent.js";
import {
  chatDetailSchema,
  chatInputSchema,
  id,
  pageOutput,
  pageSchema,
  revision,
  streamEventSchema,
  toolSchema,
  userMessageSchema,
} from "../schemas/common.js";
import { publicConfigSchema } from "../schemas/config.js";
import {
  acceptanceSchema,
  chatAcceptanceSchema,
  runDetailSchema,
  runState,
  runSummarySchema,
  searchMatchSchema,
  statusSchema,
  transcriptEntrySchema,
} from "../schemas/run.js";
import type { RouteBuilders } from "./http.js";
import type { createEventStream } from "./streams.js";

const dryRun = z.boolean().default(false);

const optionalBoolean = z
  .enum(["true", "false"])
  .transform((x) => x === "true")
  .optional();
const after = z.coerce.number().int().nonnegative().optional();
export function resourceRoutes(
  service: Service,
  { publicRoute, protectedRoute }: RouteBuilders,
  events: ReturnType<typeof createEventStream>,
) {
  const api = managementClient(service);
  const noResource = { resourceID: undefined, request: {} };
  const runFilter = operationInputs["runs list"];
  const page = <T>(
    key: string,
    input: { limit: number; cursor?: string },
    get: () => T[] | Promise<T[]>,
  ) => service.page(key, input, get);
  const accepted = (body: z.ZodType) =>
    z.union([
      z.object({ status: z.literal(200), body }),
      z.object({ status: z.literal(202), body }),
    ]);
  const reply = <T extends { replayed: boolean }>(
    body: T,
    preview: boolean,
  ) => ({
    status: body.replayed || preview ? (200 as const) : (202 as const),
    body,
  });
  return {
    operations: httpOperationRouter,
    health: publicRoute
      .route({ method: "GET", path: "/health" })
      .input(z.strictObject({}))
      .output(z.object({ ok: z.boolean(), version: z.string() }))
      .handler(() => ({ ok: true, version: packageVersion })),
    status: protectedRoute
      .route({ method: "GET", path: "/v1/status" })
      .input(z.strictObject({}))
      .output(statusSchema)
      .handler(async () => {
        const result = await api["status"](noResource);
        if (!("runtime" in result))
          throw Error("Unexpected diagnostic response");
        return result.runtime;
      }),
    configGet: protectedRoute
      .route({ method: "GET", path: "/v1/config" })
      .input(z.strictObject({}))
      .output(z.object({ config: publicConfigSchema }))
      .handler(async () => ({
        config: service.publicConfig(
          (await api["config get"](noResource)).config,
        ),
      })),
    configPatch: protectedRoute
      .route({ method: "PATCH", path: "/v1/config" })
      .input(operationInputs["config update"].extend({ dryRun }))
      .output(
        z.object({
          config: publicConfigSchema,
          changed: z.boolean(),
          restartRequired: z.boolean(),
        }),
      )
      .handler(async ({ input }) => {
        const result = await api["config update"]({
          resourceID: undefined,
          request: {
            expectedRevision: input.expectedRevision,
            changes: input.changes,
          },
          dryRun: input.dryRun,
        });
        return { ...result, config: service.publicConfig(result.config) };
      }),
    agentsList: protectedRoute
      .route({ method: "GET", path: "/v1/agents" })
      .input(pageSchema.extend({ enabled: optionalBoolean }))
      .output(pageOutput(agentSchema))
      .handler(({ input }) =>
        page("agents:" + input.enabled, input, async () =>
          (await api["agents list"](noResource)).items.filter(
            (a) => input.enabled === undefined || a.enabled === input.enabled,
          ),
        ),
      ),
    agentsCreate: protectedRoute
      .route({ method: "POST", path: "/v1/agents" })
      .input(z.strictObject({ agent: agentDraftSchema, dryRun }))
      .output(z.object({ agent: agentSchema, changed: z.boolean() }))
      .handler(({ input }) =>
        api["agents create"]({
          resourceID: undefined,
          request: { agent: input.agent },
          dryRun: input.dryRun,
        }),
      ),
    agentGet: protectedRoute
      .route({ method: "GET", path: "/v1/agents/{agentID}" })
      .input(z.strictObject({ agentID: id }))
      .output(z.object({ agent: agentSchema }))
      .handler(async ({ input }) => ({
        agent: (
          await api["agents get"]({ resourceID: input.agentID, request: {} })
        ).item,
      })),
    agentPatch: protectedRoute
      .route({ method: "PATCH", path: "/v1/agents/{agentID}" })
      .input(
        z.strictObject({
          agentID: id,
          expectedRevision: revision,
          changes: operationInputs["agents update"].shape.changes,
          dryRun,
        }),
      )
      .output(z.object({ agent: agentSchema, changed: z.boolean() }))
      .handler(({ input }) =>
        api["agents update"]({
          resourceID: input.agentID,
          request: {
            expectedRevision: input.expectedRevision,
            changes: input.changes,
          },
          dryRun: input.dryRun,
        }),
      ),
    runCreate: protectedRoute
      .route({
        method: "POST",
        path: "/v1/agents/{agentID}/runs",
        outputStructure: "detailed",
      })
      .input(
        z.strictObject({ agentID: id, message: userMessageSchema, dryRun }),
      )
      .output(accepted(acceptanceSchema))
      .handler(async ({ input }) =>
        reply(
          await api["agents run"]({
            resourceID: input.agentID,
            request: { message: input.message },
            dryRun: input.dryRun,
          }),
          input.dryRun,
        ),
      ),
    runsList: protectedRoute
      .route({ method: "GET", path: "/v1/runs" })
      .input(runFilter)
      .output(
        z.object({
          items: z.union([
            z.array(runSummarySchema),
            z.array(searchMatchSchema),
          ]),
          nextCursor: z.string().nullable(),
        }),
      )
      .handler(({ input }) =>
        api["runs list"]({ resourceID: undefined, request: input }),
      ),
    runGet: protectedRoute
      .route({ method: "GET", path: "/v1/runs/{runID}" })
      .input(z.strictObject({ runID: id }))
      .output(z.object({ run: runDetailSchema }))
      .handler(({ input }) =>
        api["runs get"]({ resourceID: input.runID, request: {} }),
      ),
    transcript: protectedRoute
      .route({ method: "GET", path: "/v1/runs/{runID}/transcript" })
      .input(pageSchema.extend({ runID: id }))
      .output(pageOutput(transcriptEntrySchema))
      .handler(({ input }) =>
        api["runs transcript"]({
          resourceID: input.runID,
          request: { limit: input.limit, cursor: input.cursor },
        }),
      ),
    runReply: protectedRoute
      .route({
        method: "POST",
        path: "/v1/runs/{runID}/replies",
        outputStructure: "detailed",
      })
      .input(z.strictObject({ runID: id, message: userMessageSchema, dryRun }))
      .output(accepted(acceptanceSchema))
      .handler(async ({ input }) =>
        reply(
          await api["runs reply"]({
            resourceID: input.runID,
            request: { message: input.message },
            dryRun: input.dryRun,
          }),
          input.dryRun,
        ),
      ),
    runCancel: protectedRoute
      .route({ method: "POST", path: "/v1/runs/{runID}/cancel" })
      .input(z.strictObject({ runID: id, dryRun }))
      .output(z.object({ runID: id, status: z.string(), changed: z.boolean() }))
      .handler(({ input }) =>
        api["runs cancel"]({
          resourceID: input.runID,
          request: {},
          dryRun: input.dryRun,
        }),
      ),
    runEvents: protectedRoute
      .route({ method: "GET", path: "/v1/runs/{runID}/events" })
      .input(z.strictObject({ runID: id, afterEventID: after }))
      .output(eventIterator(streamEventSchema))
      .handler(({ input, context }) =>
        events("run", input.runID, input.afterEventID, context.request),
      ),
    skillsList: protectedRoute
      .route({ method: "GET", path: "/v1/skills" })
      .input(pageSchema)
      .output(pageOutput(skillSchema))
      .handler(({ input }) =>
        page(
          "skills",
          input,
          async () => (await api["skills list"](noResource)).items,
        ),
      ),
    skillGet: protectedRoute
      .route({ method: "GET", path: "/v1/skills/{skillID}" })
      .input(z.strictObject({ skillID: id }))
      .output(z.object({ skill: skillSchema }))
      .handler(async ({ input }) => ({
        skill: (
          await api["skills get"]({ resourceID: input.skillID, request: {} })
        ).item,
      })),
    toolsList: protectedRoute
      .route({ method: "GET", path: "/v1/tools" })
      .input(pageSchema)
      .output(pageOutput(toolSchema))
      .handler(({ input }) =>
        page(
          "tools",
          input,
          async () => (await api["tools list"](noResource)).items,
        ),
      ),
    toolGet: protectedRoute
      .route({ method: "GET", path: "/v1/tools/{toolID}" })
      .input(z.strictObject({ toolID: id }))
      .output(z.object({ tool: toolSchema }))
      .handler(async ({ input }) => ({
        tool: (
          await api["tools get"]({ resourceID: input.toolID, request: {} })
        ).item,
      })),
    chatCreate: protectedRoute
      .route({
        method: "POST",
        path: "/v1/chat/requests",
        outputStructure: "detailed",
      })
      .input(chatInputSchema)
      .output(accepted(chatAcceptanceSchema))
      .handler(async ({ input }) =>
        reply(
          chatAcceptanceSchema.parse(
            await api["instant create"]({
              resourceID: undefined,
              request: input,
            }),
          ),
          false,
        ),
      ),
    chatGet: protectedRoute
      .route({ method: "GET", path: "/v1/chat/requests/{requestID}" })
      .input(z.strictObject({ requestID: id }))
      .output(z.object({ request: chatDetailSchema }))
      .handler(async ({ input }) => ({
        request: await api["instant get"]({
          resourceID: input.requestID,
          request: {},
        }),
      })),
    chatEvents: protectedRoute
      .route({ method: "GET", path: "/v1/chat/requests/{requestID}/events" })
      .input(z.strictObject({ requestID: id, afterEventID: after }))
      .output(eventIterator(streamEventSchema))
      .handler(({ input, context }) =>
        events("chat", input.requestID, input.afterEventID, context.request),
      ),
    chatDelete: protectedRoute
      .route({ method: "DELETE", path: "/v1/chat/requests/{requestID}" })
      .input(z.strictObject({ requestID: id, dryRun }))
      .output(
        z.object({ requestID: id, status: z.string(), changed: z.boolean() }),
      )
      .handler(({ input }) =>
        api["instant delete"]({
          resourceID: input.requestID,
          request: {},
          dryRun: input.dryRun,
        }),
      ),
  };
}
