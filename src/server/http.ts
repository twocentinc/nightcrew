import { OpenAPIGenerator } from "@orpc/openapi";
import { OpenAPIHandler } from "@orpc/openapi/node";
import { os } from "@orpc/server";
import { BodyLimitPlugin } from "@orpc/server/node";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { LlamaRuntime, samplePresence } from "../engine/models/runtime.js";
import {
  Service,
  fail,
  type Presence,
  type Runtime,
} from "../engine/service.js";
import { verifyBearerToken } from "../storage/config.js";
import { Storage } from "../storage/store.js";
import { OperationalLog } from "./logging.js";
import { resourceRoutes } from "./resources.js";
import { createEventStream } from "./streams.js";

const packageVersion = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version as string;
type Context = { request: IncomingMessage; service: Service };

function createRoutes(service: Service) {
  const publicRoute = os.$context<Context>();
  const protectedRoute = publicRoute.use(async ({ context, next }) => {
    const header = context.request.headers.authorization;
    if (!verifyBearerToken(header, service.storage.store.config.rootTokenHash))
      fail("unauthorized", 401);
    return next();
  });
  return { publicRoute, protectedRoute };
}
export type RouteBuilders = ReturnType<typeof createRoutes>;

export function createRouter(service: Service) {
  return resourceRoutes(
    service,
    createRoutes(service),
    createEventStream(service),
  );
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
            context: { request, service },
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
    if (storage.store.config.httpEnabled)
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
        if (server.listening)
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

export { initializeHome } from "../storage/config.js";
