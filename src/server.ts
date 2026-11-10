import { OperationalLog, loggingSchema } from "./logging.js";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { timingSafeEqual, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { os, eventIterator, withEventMeta } from "@orpc/server";
import { BodyLimitPlugin } from "@orpc/server/node";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { z } from "zod";
import {
  id,
  agentDraftSchema,
  agentSchema,
  slotSchema,
  pageSchema,
  runState,
  userMessageSchema,
  chatInputSchema,
  terminal,
  publicConfigSchema,
  runSummarySchema,
  runDetailSchema,
  transcriptEntrySchema,
  chatDetailSchema,
  toolSchema,
  statusSchema,
  streamEventSchema,
  searchMatchSchema,
  acceptanceSchema,
  chatAcceptanceSchema,
  pageOutput,
  skillSchema,
} from "./contracts.js";
import { Storage, canonical, tokenHash } from "./storage.js";
import {
  Service,
  fail,
  tools,
  type Runtime,
  type Presence,
} from "./service.js";
import { LlamaRuntime, samplePresence } from "./runtime.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;
type Context = { request: IncomingMessage };

const dryRun = z.boolean().default(false);
const revision = z.number().int().positive();
const optionalBoolean = z
  .enum(["true", "false"])
  .transform((x) => x === "true")
  .optional();
const after = z.coerce.number().int().nonnegative().optional();
export function createRouter(service: Service) {
  const publicRoute = os.$context<Context>();
  const protectedRoute = publicRoute.use(async ({ context, next }) => {
    const header = context.request.headers.authorization;
    if (!header?.startsWith("Bearer ")) fail("unauthorized", 401);
    if (
      !timingSafeEqual(
        Buffer.from(tokenHash(header.slice(7)), "hex"),
        Buffer.from(service.storage.store.config.rootTokenHash, "hex"),
      )
    )
      fail("unauthorized", 401);
    return next();
  });
  let streams = 0;
  const events = async (
    kind: "run" | "chat",
    resourceID: string,
    afterEventID: number | undefined,
    request: IncomingMessage,
  ) => {
    const header = request.headers["last-event-id"];
    if (
      Array.isArray(header) ||
      (header !== undefined && !/^\d+$/.test(header))
    )
      fail("invalid_event_id");
    if (
      header !== undefined &&
      afterEventID !== undefined &&
      Number(header) !== afterEventID
    )
      fail("event_id_mismatch");
    let position = afterEventID ?? Number(header ?? 0);
    const get = async () =>
      kind === "run" ? await service.run(resourceID) : service.chat(resourceID);
    const initial = await get();
    if (position > initial.events.length) fail("invalid_event_id");
    if (streams >= 10) fail("stream_capacity", 429);
    streams++;
    async function* stream() {
      let attemptID = "",
        offset = 0;
      try {
        while (true) {
          if (
            tokenHash(request.headers.authorization?.slice(7) ?? "") !==
            service.storage.store.config.rootTokenHash
          )
            fail("unauthorized", 401);
          const record = await get();
          for (const e of record.events.slice(position)) {
            position = e.sequence;
            yield withEventMeta(
              {
                eventID: e.sequence,
                type: e.type,
                at: e.at,
                resourceID,
                segment: e.segment,
                data: e.data,
              },
              { id: String(e.sequence) },
            );
          }
          const provisional = service.provisional.get(resourceID);
          if (provisional) {
            if (provisional.attemptID !== attemptID) {
              attemptID = provisional.attemptID;
              offset = 0;
              yield {
                eventID: position,
                type: "textDelta",
                at: new Date().toISOString(),
                resourceID,
                segment:
                  kind === "run"
                    ? "segment" in record
                      ? record.segment
                      : 0
                    : 0,
                data: { attemptID, reset: true, text: "" },
              };
            }
            if (provisional.text.length > offset) {
              yield {
                eventID: position,
                type: "textDelta",
                at: new Date().toISOString(),
                resourceID,
                segment: "segment" in record ? record.segment : 0,
                data: {
                  attemptID,
                  reset: false,
                  text: provisional.text.slice(offset),
                },
              };
              offset = provisional.text.length;
            }
          }
          if (terminal(record.state)) return;
          await delay(250);
        }
      } finally {
        streams--;
      }
    }
    return stream();
  };
  const runFilter = pageSchema.extend({
    agentID: id.optional(),
    state: runState.optional(),
  });
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
    health: publicRoute
      .route({ method: "GET", path: "/health" })
      .input(z.strictObject({}))
      .output(z.object({ ok: z.boolean(), version: z.string() }))
      .handler(() => ({ ok: true, version: packageVersion })),
    status: protectedRoute
      .route({ method: "GET", path: "/v1/status" })
      .input(z.strictObject({}))
      .output(statusSchema)
      .handler(() => service.status()),
    configGet: protectedRoute
      .route({ method: "GET", path: "/v1/config" })
      .input(z.strictObject({}))
      .output(z.object({ config: publicConfigSchema }))
      .handler(() => ({ config: service.publicConfig() })),
    configPatch: protectedRoute
      .route({ method: "PATCH", path: "/v1/config" })
      .input(
        z.strictObject({
          expectedRevision: revision,
          changes: z
            .strictObject({
              logging: loggingSchema.optional(),
              interactionCooldownMs: z
                .number()
                .int()
                .min(0)
                .max(3600000)
                .optional(),
              slots: z.array(slotSchema).max(32).optional(),
              modelIdlePolicies: z
                .array(
                  z.strictObject({
                    modelID: id,
                    idleUnloadMs: z.number().int().min(0).max(86400000),
                  }),
                )
                .max(32)
                .optional(),
            })
            .refine((x) => Object.keys(x).length > 0),
          dryRun,
        }),
      )
      .output(
        z.object({
          config: publicConfigSchema,
          changed: z.boolean(),
          restartRequired: z.boolean(),
        }),
      )
      .handler(({ input }) =>
        service.patchConfig(
          input.expectedRevision,
          input.changes,
          input.dryRun,
        ),
      ),
    agentsList: protectedRoute
      .route({ method: "GET", path: "/v1/agents" })
      .input(pageSchema.extend({ enabled: optionalBoolean }))
      .output(pageOutput(agentSchema))
      .handler(({ input }) =>
        page("agents:" + input.enabled, input, () =>
          service.storage.store.agents.filter(
            (a) => input.enabled === undefined || a.enabled === input.enabled,
          ),
        ),
      ),
    agentsCreate: protectedRoute
      .route({ method: "POST", path: "/v1/agents" })
      .input(z.strictObject({ agent: agentDraftSchema, dryRun }))
      .output(z.object({ agent: agentSchema, changed: z.boolean() }))
      .handler(({ input }) => service.createAgent(input.agent, input.dryRun)),
    agentGet: protectedRoute
      .route({ method: "GET", path: "/v1/agents/{agentID}" })
      .input(z.strictObject({ agentID: id }))
      .output(z.object({ agent: agentSchema }))
      .handler(({ input }) => ({ agent: service.agent(input.agentID) })),
    agentPatch: protectedRoute
      .route({ method: "PATCH", path: "/v1/agents/{agentID}" })
      .input(
        z.strictObject({
          agentID: id,
          expectedRevision: revision,
          changes: agentSchema
            .omit({
              agentID: true,
              revision: true,
              createdAt: true,
              updatedAt: true,
            })
            .partial()
            .extend({
              thinking: z.boolean().optional(),
              temperature: z.number().min(0).max(2).optional(),
              maxOutputTokens: z.number().int().min(1).max(32768).optional(),
            })
            .refine((x) => Object.keys(x).length > 0),
          dryRun,
        }),
      )
      .output(z.object({ agent: agentSchema, changed: z.boolean() }))
      .handler(({ input }) =>
        service.patchAgent(
          input.agentID,
          input.expectedRevision,
          input.changes,
          input.dryRun,
        ),
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
          await service.submit(
            input.agentID,
            input.message,
            false,
            input.dryRun,
          ),
          input.dryRun,
        ),
      ),
    runsList: protectedRoute
      .route({ method: "GET", path: "/v1/runs" })
      .input(runFilter)
      .output(pageOutput(runSummarySchema))
      .handler(({ input }) =>
        page("runs:" + canonical([input.agentID, input.state]), input, () =>
          service.listRuns(input.agentID, input.state),
        ),
      ),
    runsSearch: protectedRoute
      .route({ method: "GET", path: "/v1/runs/search" })
      .input(runFilter.extend({ query: z.string().min(1).max(200) }))
      .output(pageOutput(searchMatchSchema))
      .handler(({ input }) =>
        page(
          "search:" + canonical([input.query, input.agentID, input.state]),
          input,
          () => service.search(input.query, input.agentID, input.state),
        ),
      ),
    runGet: protectedRoute
      .route({ method: "GET", path: "/v1/runs/{runID}" })
      .input(z.strictObject({ runID: id }))
      .output(z.object({ run: runDetailSchema }))
      .handler(async ({ input }) => ({
        run: service.detail(await service.run(input.runID)),
      })),
    transcript: protectedRoute
      .route({ method: "GET", path: "/v1/runs/{runID}/transcript" })
      .input(pageSchema.extend({ runID: id }))
      .output(pageOutput(transcriptEntrySchema))
      .handler(({ input }) =>
        page("transcript:" + input.runID, input, async () =>
          service.transcript(await service.run(input.runID)),
        ),
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
          await service.submit(input.runID, input.message, true, input.dryRun),
          input.dryRun,
        ),
      ),
    runCancel: protectedRoute
      .route({ method: "POST", path: "/v1/runs/{runID}/cancel" })
      .input(z.strictObject({ runID: id, dryRun }))
      .output(z.object({ runID: id, status: z.string(), changed: z.boolean() }))
      .handler(({ input }) => service.cancelRun(input.runID, input.dryRun)),
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
        page("skills", input, () => [...service.skills.values()]),
      ),
    skillGet: protectedRoute
      .route({ method: "GET", path: "/v1/skills/{skillID}" })
      .input(z.strictObject({ skillID: id }))
      .output(z.object({ skill: skillSchema }))
      .handler(({ input }) => ({
        skill:
          service.skills.get(input.skillID) ?? fail("skill_not_found", 404),
      })),
    toolsList: protectedRoute
      .route({ method: "GET", path: "/v1/tools" })
      .input(pageSchema)
      .output(pageOutput(toolSchema))
      .handler(({ input }) =>
        page("tools", input, () => [...service.tools.values()]),
      ),
    toolGet: protectedRoute
      .route({ method: "GET", path: "/v1/tools/{toolID}" })
      .input(z.strictObject({ toolID: id }))
      .output(z.object({ tool: toolSchema }))
      .handler(({ input }) => ({
        tool:
          [...service.tools.values()].find((t) => t.toolID === input.toolID) ??
          fail("tool_not_found", 404),
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
        reply(await service.submitChat(input), false),
      ),
    chatGet: protectedRoute
      .route({ method: "GET", path: "/v1/chat/requests/{requestID}" })
      .input(z.strictObject({ requestID: id }))
      .output(z.object({ request: chatDetailSchema }))
      .handler(({ input }) => ({
        request: service.chatDetail(service.chat(input.requestID)),
      })),
    chatEvents: protectedRoute
      .route({ method: "GET", path: "/v1/chat/requests/{requestID}/events" })
      .input(z.strictObject({ requestID: id, afterEventID: after }))
      .output(eventIterator(streamEventSchema))
      .handler(({ input, context }) =>
        events("chat", input.requestID, input.afterEventID, context.request),
      ),
    chatCancel: protectedRoute
      .route({ method: "POST", path: "/v1/chat/requests/{requestID}/cancel" })
      .input(z.strictObject({ requestID: id, dryRun }))
      .output(
        z.object({ requestID: id, status: z.string(), changed: z.boolean() }),
      )
      .handler(({ input }) =>
        service.cancelChat(input.requestID, input.dryRun),
      ),
  };
}
export async function startServer(options: {
  home: string;
  runtime?: Runtime;
  presence?: () => Promise<Presence>;
  port?: number;
  quiet?: boolean;
}) {
  const logger = new OperationalLog(
    options.home,
    () =>
      storage.store?.config.logging ?? {
        level: "warn",
        maxBytes: 1048576,
        files: 3,
      },
    options.quiet,
  );
  const storage = new Storage(options.home, logger);
  const runtime =
    options.runtime ??
    new LlamaRuntime(() => storage.store.config, options.home, logger);
  const service = new Service(
    storage,
    runtime,
    options.presence ?? samplePresence,
    logger,
  );
  await service.initialize();
  try {
    const router = createRouter(service);
    const document = await new OpenAPIGenerator({
      schemaConverters: [new ZodToJsonSchemaConverter()],
    }).generate(router, {
      info: { title: "Nightcrew", version: packageVersion },
      components: {
        securitySchemes: { rootToken: { type: "http", scheme: "bearer" } },
      },
      security: [{ rootToken: [] }],
    });
    document.paths ??= {};
    document.paths["/openapi.json"] = {
      get: {
        operationId: "openapi",
        security: [],
        responses: {
          "200": {
            description: "Generated OpenAPI document",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    };
    if (document.paths?.["/health"]?.get)
      document.paths["/health"].get.security = [];
    const handler = new OpenAPIHandler(router, {
      eventIteratorKeepAliveInterval: 15000,
      plugins: [new BodyLimitPlugin({ maxBodySize: 16 * 1024 * 1024 })],
      customErrorResponseBodyEncoder: (error) => ({
        code: error.code,
        message: error.status >= 500 ? "Operation failed" : error.message,
        retrySafety: "inspect_before_retry",
        requestID: randomUUID(),
        details: null,
      }),
    });
    const server = createServer(
      { requestTimeout: 30000, headersTimeout: 10000 },
      async (request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.setTimeout(30000, () => response.destroy());
        try {
          if (request.method === "GET" && request.url === "/openapi.json") {
            response.setHeader("Content-Type", "application/json");
            response.end(JSON.stringify(document));
            return;
          }
          const { matched } = await handler.handle(request, response, {
            context: { request },
          });
          if (!matched) {
            response.writeHead(404, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                code: "not_found",
                message: "Route not found",
                retrySafety: "safe",
                requestID: randomUUID(),
                details: null,
              }),
            );
          }
        } catch {
          if (!response.headersSent) {
            response.writeHead(500, { "Content-Type": "application/json" });
            response.end(
              JSON.stringify({
                code: "internal_error",
                message: "Operation failed",
                retrySafety: "inspect_before_retry",
                requestID: randomUUID(),
                details: null,
              }),
            );
          } else response.destroy();
        }
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        options.port ?? storage.store.config.port,
        storage.store.config.host,
        () => {
          server.off("error", reject);
          resolve();
        },
      );
    });
    return {
      server,
      service,
      document,
      logger,
      close: async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) =>
          server.close((e) => (e ? reject(e) : resolve())),
        );
        await service.close();
        await logger.flush();
      },
    };
  } catch (e) {
    await service.close();
    throw e;
  }
}

export { initializeHome } from "./storage.js";
