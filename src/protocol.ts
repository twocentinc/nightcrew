import { loggingSchema } from "./logging.js";
import { z } from "zod";
import { readFileSync } from "node:fs";
import {
  agentDraftSchema,
  agentSchema,
  configSchema,
  modelSchema,
  slotSchema,
  skillSchema,
  userMessageSchema,
  pageSchema,
  id,
  runState,
} from "./contracts.js";
import { toolDefinitionSchema } from "./registry.js";
export const PROTOCOL_VERSION = 1;
export const SCHEMA_VERSION = 9;
export const packageVersion = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version as string;
export const EXIT_CODES = {
  success: 0,
  internal: 1,
  invalidInput: 2,
  configuration: 3,
  unsupported: 4,
  dependency: 5,
  timeout: 6,
  notFound: 7,
  confirmation: 8,
  conflict: 9,
} as const;
export const errorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  retrySafety: z.enum(["safe", "unsafe", "never"]),
  details: z.record(z.string(), z.json()),
  exitCode: z.number().int().min(1).max(9),
});
const context = {
  version: z.literal(PROTOCOL_VERSION),
  requestID: z.string(),
  command: z.string(),
};
export const errorEnvelopeSchema = z.strictObject({
  ...context,
  ok: z.literal(false),
  error: errorSchema,
});
export const successEnvelopeSchema = z.strictObject({
  ...context,
  ok: z.literal(true),
  result: z.json(),
});
export type RetrySafety = z.infer<typeof errorSchema>["retrySafety"];
export class NightcrewError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode: number = 1,
    readonly retrySafety: RetrySafety = "never",
    readonly details: Record<string, z.infer<ReturnType<typeof z.json>>> = {},
  ) {
    super(message);
    this.name = "NightcrewError";
  }
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retrySafety: this.retrySafety,
      details: this.details,
      exitCode: this.exitCode,
    };
  }
}
export const invalidInput = (message: string) =>
  new NightcrewError("cli.invalidInput", message, 2);
export const timeoutFailure = (mutation: boolean) =>
  new NightcrewError(
    "runtime.timeout",
    "Operation exceeded its deadline",
    6,
    mutation ? "unsafe" : "safe",
    { outcomeUnknown: mutation },
  );
export function normalizeError(
  error: unknown,
  mutation = false,
): NightcrewError {
  if (error instanceof NightcrewError) return error;
  if (error instanceof z.ZodError)
    return new NightcrewError(
      "cli.invalidInput",
      "Request does not match its schema",
      2,
      "never",
      {
        issues: error.issues.map((i) => ({
          path: i.path.map(String).join("."),
          message: i.message,
        })),
      },
    );
  if (error instanceof SyntaxError)
    return invalidInput("Input is not valid JSON");
  const e = error as {
    code?: string;
    status?: number;
    name?: string;
    message?: string;
  };
  if (e?.name === "AbortError" || e?.name === "TimeoutError")
    return timeoutFailure(mutation);
  if (e?.code === "OFFLINE")
    return new NightcrewError(
      "daemon.unavailable",
      "Daemon is unavailable",
      7,
      "safe",
    );
  if (e?.code === "ENOENT")
    return new NightcrewError(
      "resource.notFound",
      "Required file or resource is missing",
      7,
      "never",
    );
  if (e?.code === "EACCES" || e?.code === "EPERM")
    return new NightcrewError(
      "config.permissionDenied",
      "Permission denied",
      3,
    );
  if (e?.code === "EEXIST")
    return new NightcrewError("resource.exists", "Resource already exists", 9);
  if (e?.code === "ENOSPC")
    return new NightcrewError(
      "storage.full",
      "Not enough space to commit state",
      3,
      "unsafe",
      { outcomeUnknown: mutation },
    );
  if (e?.code === "confirmation_required")
    return new NightcrewError(
      "cli.confirmationRequired",
      "Explicit confirmation is required",
      8,
      "never",
      { authorizationFlag: "--yes" },
    );
  if (
    e?.code === "revision_conflict" ||
    e?.code === "message_conflict" ||
    e?.code === "already_exists" ||
    e?.code === "runtime_busy" ||
    e?.status === 409
  )
    return new NightcrewError(
      "resource." + (e.code ?? "conflict"),
      e.message ?? "Resource conflict",
      9,
      "never",
    );
  if (e?.status === 410)
    return new NightcrewError(
      "resource.cursorExpired",
      "Cursor expired; restart pagination",
      9,
      "safe",
    );
  if (e?.status === 404 || e?.code === "not_found")
    return new NightcrewError("resource.notFound", "Resource not found", 7);
  if (e?.status === 400)
    return new NightcrewError(
      "cli." + (e.code ?? "invalidInput"),
      e.message ?? "Invalid input",
      2,
    );
  if (e?.status === 503 || e?.code === "ECONNREFUSED")
    return new NightcrewError(
      "runtime.unavailable",
      "Runtime dependency unavailable",
      5,
      mutation ? "unsafe" : "safe",
      { outcomeUnknown: mutation },
    );
  return new NightcrewError(
    "runtime.internalFailure",
    "Operation failed",
    1,
    mutation ? "unsafe" : "safe",
    { outcomeUnknown: mutation },
  );
}
const revision = z.number().int().positive();
const object = z.strictObject({});
export const requestSchemas: Record<string, z.ZodType> = {
  "runs list": pageSchema.extend({
    agentID: id.optional(),
    state: runState.optional(),
  }),
  "runs transcript": pageSchema,
  "runs search": pageSchema.extend({
    agentID: id.optional(),
    state: runState.optional(),
  }),
  "runs export": z.strictObject({ destination: z.string().min(1).max(4096) }),
  "runs verify": z.strictObject({
    bundle: z.string().min(1).max(4096).optional(),
  }),
  init: configSchema
    .omit({ rootTokenHash: true, revision: true })
    .partial()
    .extend({
      host: configSchema.shape.host.default("127.0.0.1"),
      port: configSchema.shape.port.default(6970),
      interactionCooldownMs:
        configSchema.shape.interactionCooldownMs.default(300000),
      models: configSchema.shape.models.default([]),
      slots: configSchema.shape.slots.default([]),
      hooks: configSchema.shape.hooks.default([]),
    }),
  "config update": z.strictObject({
    expectedRevision: revision,
    changes: configSchema
      .omit({ rootTokenHash: true, revision: true })
      .partial()
      .extend({ logging: loggingSchema.optional() }),
  }),
  "agents create": z.strictObject({ agent: agentDraftSchema }),
  "agents update": z.strictObject({
    expectedRevision: revision,
    changes: agentSchema
      .omit({ agentID: true, revision: true, createdAt: true, updatedAt: true })
      .partial()
      .extend({
        thinking: z.boolean().optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.number().int().min(1).max(32768).optional(),
      }),
  }),
  "agents enable": z.strictObject({ expectedRevision: revision }),
  "agents disable": z.strictObject({ expectedRevision: revision }),
  "agents delete": z.strictObject({ expectedRevision: revision }),
  "models create": z.strictObject({
    model: modelSchema,
    slots: z.array(slotSchema).max(32),
  }),
  "models update": z.strictObject({
    expectedRevision: revision,
    changes: modelSchema.omit({ modelID: true }).partial(),
  }),
  "models delete": z.strictObject({ expectedRevision: revision }),
  "slots create": z.strictObject({ slot: slotSchema }),
  "slots update": z.strictObject({
    expectedRevision: revision,
    changes: slotSchema.omit({ slotID: true }).partial(),
  }),
  "slots delete": z.strictObject({ expectedRevision: revision }),
  "skills create": z.strictObject({ skill: skillSchema }),
  "skills update": z.strictObject({
    expectedHash: z.string(),
    skill: skillSchema,
  }),
  "skills delete": z.strictObject({ expectedHash: z.string() }),
  "tools create": z.strictObject({ tool: toolDefinitionSchema }),
  "tools update": z.strictObject({
    expectedHash: z.string(),
    tool: toolDefinitionSchema,
  }),
  "tools delete": z.strictObject({ expectedHash: z.string() }),
};
requestSchemas["agents run"] = z.strictObject({ message: userMessageSchema });
requestSchemas["runs reply"] = z.strictObject({ message: userMessageSchema });
