import path from "node:path";
import { z } from "zod";
import { Storage, initializeHome, readJSON } from "./storage.js";
import { Service } from "./service.js";
import { manage, type ManagementInput } from "./management.js";
import { control, runDaemon } from "./daemon.js";
import { startup, startupStatus, startupLogs } from "./startup.js";
import { LlamaRuntime, samplePresence } from "./runtime.js";
import {
  doctor,
  capabilities,
  doctorSchema,
  capabilitiesSchema,
} from "./diagnostics.js";
import {
  requestSchemas,
  packageVersion,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  invalidInput,
  NightcrewError,
  errorEnvelopeSchema,
  successEnvelopeSchema,
  normalizeError,
} from "./protocol.js";
import {
  currentExecution,
  remainingTimeout,
  pause,
  checkpoint,
  diagnostic,
} from "./execution.js";
import {
  agentSchema,
  modelSchema,
  slotSchema,
  skillSchema,
  configSchema,
  storeSchema,
  runSummarySchema,
  runDetailSchema,
  transcriptEntrySchema,
  acceptanceSchema,
  statusSchema,
  searchMatchSchema,
} from "./contracts.js";
import { toolDefinitionSchema } from "./registry.js";
export type CommandContext = {
  home: string;
  resourceID?: string;
  request: unknown;
  dryRun: boolean;
  yes: boolean;
  values: Record<string, string | boolean>;
  helpScope?: string;
};
export type Definition = {
  name: string;
  description: string;
  scope: "static" | "local" | "management" | "daemon";
  operand: "none" | "required" | "scope";
  mutates: boolean;
  confirmation: boolean;
  options: string[];
  request: z.ZodType;
  result: z.ZodType;
  handler: (context: CommandContext) => Promise<unknown>;
};
const empty = z.strictObject({});
const changed = z.object({ changed: z.boolean() });
const adminConfig = configSchema.omit({ rootTokenHash: true });
const configMutation = z.object({
  changed: z.boolean(),
  restartRequired: z.boolean(),
  config: adminConfig,
  agentID: z.string().optional(),
});
const serviceStatus = z.object({
  label: z.string(),
  plistPath: z.string(),
  configured: z.boolean(),
  loaded: z.boolean(),
  running: z.boolean(),
  pid: z.number().nullable(),
  state: z.string().nullable(),
  lastExitStatus: z.string().nullable(),
});
const startupResult = z.union([
  serviceStatus.extend({ changed: z.boolean() }),
  z.object({
    changed: z.literal(false),
    action: z.string(),
    label: z.string(),
    plistPath: z.string(),
    plist: z.string().optional(),
  }),
]);
export const globalOptions = {
  home: "absolute-path",
  "request-id": "ID",
  timeout: "duration",
  quiet: false,
  verbose: false,
  verbosity: "quiet|normal|verbose|debug",
  "no-input": false,
  "non-interactive": false,
  help: false,
  version: false,
} as const;
const definitions: Definition[] = [];
function define(
  name: string,
  description: string,
  scope: Definition["scope"],
  operand: Definition["operand"],
  mutates: boolean,
  result: z.ZodType,
  handler: Definition["handler"],
  extras: {
    confirmation?: boolean;
    options?: string[];
    request?: z.ZodType;
  } = {},
) {
  const request = extras.request ?? requestSchemas[name] ?? empty;
  definitions.push({
    name,
    description,
    scope,
    operand,
    mutates,
    confirmation: extras.confirmation ?? false,
    options: [
      ...(request !== empty ? ["request"] : []),
      ...(mutates ? ["dry-run"] : []),
      ...(extras.confirmation ? ["yes"] : []),
      ...(extras.options ?? []),
    ],
    request,
    result,
    handler,
  });
}
async function management(
  context: CommandContext,
  name: string,
  scope: Definition["scope"],
) {
  const input: ManagementInput = {
    command: name,
    ...(context.resourceID ? { resourceID: context.resourceID } : {}),
    request: context.request,
    dryRun: context.dryRun,
    yes: context.yes,
  };
  try {
    return await control(context.home, input, remainingTimeout(90000));
  } catch (e) {
    if ((e as { code?: string }).code !== "OFFLINE" || scope === "daemon")
      throw e;
    diagnostic("verbose", "command.offline", { command: name });
    checkpoint();
    const storage = new Storage(context.home);
    const state = await readJSON(
      path.join(context.home, "config.json"),
      storeSchema,
      8 * 1024 * 1024,
    );
    if (getCommand(name)!.mutates) await storage.initialize();
    else storage.store = state;
    const service = new Service(
      storage,
      {
        generate: async () => {
          throw new NightcrewError("daemon.required", "Daemon required", 7);
        },
        close: async () => {},
        status: () => [],
      },
      samplePresence,
    );
    try {
      await service.reloadRegistry();
      checkpoint();
      return await manage(service, input);
    } finally {
      await storage.close();
    }
  }
}
const managed = (
  name: string,
  description: string,
  result: z.ZodType,
  mutates = false,
  operand: Definition["operand"] = "none",
  confirmation = false,
  scope: Definition["scope"] = "management",
  options: string[] = [],
) =>
  define(
    name,
    description,
    scope,
    operand,
    mutates,
    result,
    (c) => management(c, name, scope),
    { confirmation, options },
  );
const helpDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.string(),
  operand: z.string(),
  mutates: z.boolean(),
  confirmation: z.boolean(),
  options: z.array(z.string()),
  requestSchema: z.string(),
  resultSchema: z.string(),
});
define(
  "help",
  "Discover commands and their contracts",
  "static",
  "scope",
  false,
  z.object({
    scope: z.string(),
    commands: z.array(z.string()),
    definitions: z.array(helpDefinitionSchema),
    options: z.array(z.string()),
    schemaVersion: z.number(),
  }),
  async (c) => help(c.helpScope ?? c.resourceID ?? ""),
);
define(
  "version",
  "Report package, protocol and schema versions",
  "static",
  "none",
  false,
  z.object({
    version: z.string(),
    protocolVersion: z.number(),
    schemaVersion: z.number(),
  }),
  async () => ({
    version: packageVersion,
    protocolVersion: PROTOCOL_VERSION,
    schemaVersion: SCHEMA_VERSION,
  }),
);
define(
  "schema get",
  "Read a generated request or result schema",
  "static",
  "required",
  false,
  z.object({
    name: z.string(),
    schemaVersion: z.number(),
    schema: z.record(z.string(), z.json()),
  }),
  async (c) => {
    const schemas = exportSchemas();
    let name = c.resourceID!;
    if (
      !name.endsWith(".request") &&
      !name.endsWith(".result") &&
      !name.startsWith("envelope.")
    )
      name += ".request";
    const schema = schemas[name];
    if (!schema)
      throw new NightcrewError(
        "resource.schemaNotFound",
        "Schema not found",
        7,
      );
    return { name, schemaVersion: SCHEMA_VERSION, schema };
  },
);
define(
  "init",
  "Initialize a private runtime home without overwriting it",
  "local",
  "none",
  true,
  z.union([
    z.object({ changed: z.literal(true), home: z.string(), token: z.string() }),
    z.object({
      changed: z.literal(false),
      home: z.string(),
      settings: adminConfig.omit({ revision: true }),
    }),
  ]),
  async (c) => {
    const settings = c.request as Parameters<typeof initializeHome>[1];
    return c.dryRun
      ? { changed: false, home: c.home, settings }
      : {
          changed: true,
          home: c.home,
          ...(await initializeHome(c.home, settings)),
        };
  },
);
define(
  "doctor",
  "Check configuration, executables, presence and optional live daemon readiness",
  "local",
  "none",
  false,
  doctorSchema,
  (c) =>
    doctor(c.home, !!c.values.live, (timeout) =>
      control(c.home, { command: "daemon status" }, timeout),
    ),
  { options: ["live"] },
);
define(
  "capabilities",
  "Report model adapter capabilities and verification limits",
  "local",
  "none",
  false,
  capabilitiesSchema,
  (c) => capabilities(c.home),
);
define(
  "presence sample",
  "Sample this desktop's presence without requiring a daemon or runtime home",
  "local",
  "none",
  false,
  statusSchema.shape.presence,
  async () => {
    try {
      return await samplePresence();
    } catch {
      checkpoint();
      return {
        state: "present",
        reason: "samplingFailure",
        samplingHealthy: false,
        observedAt: new Date().toISOString(),
        diagnostic: "Presence sampling failed",
      };
    }
  },
);
define(
  "presence status",
  "Inspect the daemon's latest presence sample and interaction cooldown",
  "daemon",
  "none",
  false,
  statusSchema.pick({ presence: true, cooldownUntil: true }),
  async (c) => {
    const status = statusSchema.parse(
      await control(
        c.home,
        { command: "daemon status" },
        remainingTimeout(90000),
      ),
    );
    return { presence: status.presence, cooldownUntil: status.cooldownUntil };
  },
);
managed(
  "auth rotate",
  "Replace the HTTP root token and return it once",
  changed.extend({ token: z.string().optional() }),
  true,
  "none",
  true,
);
define(
  "daemon run",
  "Run the daemon in the foreground",
  "local",
  "none",
  true,
  z.object({ changed: z.literal(false), home: z.string() }),
  async (c) => {
    if (c.dryRun) return { changed: false, home: c.home };
    await runDaemon(c.home, !!c.values.quiet || c.values.verbosity === "quiet");
    return undefined;
  },
);
managed(
  "daemon status",
  "Inspect current daemon and scheduler state",
  statusSchema.extend({ pid: z.number() }),
  false,
  "none",
  false,
  "daemon",
);
define(
  "daemon stop",
  "Gracefully stop the selected daemon",
  "daemon",
  "none",
  true,
  z.union([
    startupResult,
    z.object({ stopped: z.boolean(), pid: z.number() }),
    z.object({ stopping: z.boolean(), pid: z.number() }),
  ]),
  async (c) => {
    if (process.platform === "darwin") {
      const status = await startupStatus();
      if (status.loaded)
        return startup("stop", c.home, {
          dryRun: c.dryRun,
          yes: c.yes,
          timeoutMs: remainingTimeout(90000),
        });
    }
    const result = (await control(
      c.home,
      { command: "daemon stop", dryRun: c.dryRun },
      remainingTimeout(90000),
    )) as { pid: number; stopping: boolean };
    if (c.dryRun) return result;
    while (true) {
      checkpoint();
      try {
        process.kill(result.pid, 0);
      } catch {
        return { stopped: true, pid: result.pid };
      }
      await pause(100);
    }
  },
);
for (const action of [
  "install",
  "uninstall",
  "status",
  "start",
  "stop",
  "restart",
  "logs",
]) {
  const name = "startup " + action;
  const mutation = !["status", "logs"].includes(action);
  const result =
    action === "status"
      ? serviceStatus
      : action === "logs"
        ? z.object({
            nextCursor: z.string().nullable(),
            files: z.array(
              z.object({
                path: z.string(),
                lines: z.array(z.string()),
                truncated: z.boolean(),
              }),
            ),
          })
        : startupResult;
  define(
    name,
    `${action} the per-user LaunchAgent`,
    "local",
    "none",
    mutation,
    result,
    async (c) => {
      if (action === "logs")
        return startupLogs(
          c.home,
          Number(c.values.lines ?? 100),
          Number(c.values.limit ?? 100),
          c.values.cursor as string | undefined,
        );
      if (["install", "start", "restart"].includes(action)) {
        const state = await readJSON(
          path.join(c.home, "config.json"),
          storeSchema,
          8 * 1024 * 1024,
        );
        if (!c.dryRun) await new LlamaRuntime(() => state.config).initialize();
      }
      let result = await startup(action, c.home, {
        dryRun: c.dryRun,
        yes: c.yes,
        timeoutMs: remainingTimeout(90000),
      });
      if (!c.dryRun && ["install", "start", "restart"].includes(action)) {
        while (true) {
          checkpoint();
          try {
            await control(
              c.home,
              { command: "daemon status" },
              remainingTimeout(1000),
            );
            break;
          } catch (e) {
            checkpoint();
            diagnostic("debug", "startup.waitingForReadiness");
          }
          await pause(200);
        }
        result = { ...result, ...(await startupStatus()) };
      }
      return result;
    },
    {
      confirmation: action === "uninstall",
      options: action === "logs" ? ["lines", "limit", "cursor"] : [],
    },
  );
}
managed(
  "config get",
  "Read redacted configuration",
  z.object({ config: adminConfig }),
);
managed(
  "config update",
  "Apply revision-checked configuration changes",
  configMutation,
  true,
);
for (const [resource, schema] of Object.entries({
  agents: agentSchema,
  models: modelSchema,
  slots: slotSchema,
  skills: skillSchema.extend({ hash: z.string() }),
  tools: toolDefinitionSchema.safeExtend({
    hash: z.string(),
    builtin: z.boolean(),
  }),
})) {
  managed(
    resource + " list",
    "List " + resource,
    z.object({ items: z.array(schema) }),
  );
  managed(
    resource + " get",
    "Inspect one " + resource.slice(0, -1),
    z.object({ item: schema }),
    false,
    "required",
  );
  for (const action of ["create", "update", "delete"]) {
    let result: z.ZodType = configMutation;
    if (resource === "agents" && action !== "delete")
      result = z.object({ agent: agentSchema, changed: z.boolean() });
    if (resource === "skills" || resource === "tools")
      result = z.object({
        changed: z.boolean(),
        item: (resource === "skills"
          ? skillSchema.extend({ hash: z.string() })
          : toolDefinitionSchema.safeExtend({ hash: z.string() })
        ).nullable(),
      });
    managed(
      resource + " " + action,
      `${action} ${resource}`,
      result,
      true,
      action === "create" ? "none" : "required",
      action === "delete",
    );
  }
}
for (const action of ["enable", "disable"])
  managed(
    "agents " + action,
    action + " automatic agent eligibility",
    z.object({ agent: agentSchema, changed: z.boolean() }),
    true,
    "required",
  );
managed(
  "agents run",
  "Submit a fresh managed run",
  acceptanceSchema,
  true,
  "required",
  false,
  "daemon",
);
managed(
  "runs list",
  "List durable run summaries",
  z.object({
    items: z.array(runSummarySchema),
    nextCursor: z.string().nullable(),
  }),
  false,
  "none",
  false,
  "daemon",
  ["limit", "cursor", "agent", "state"],
);
managed(
  "runs get",
  "Inspect a durable run",
  z.object({ run: runDetailSchema }),
  false,
  "required",
  false,
  "daemon",
);
managed(
  "runs transcript",
  "Read committed run evidence",
  z.object({
    items: z.array(transcriptEntrySchema),
    nextCursor: z.string().nullable(),
  }),
  false,
  "required",
  false,
  "daemon",
  ["limit", "cursor"],
);
managed(
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
);
managed(
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
);
managed(
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
);
managed(
  "runs reply",
  "Submit a continuation",
  acceptanceSchema,
  true,
  "required",
  false,
  "daemon",
);
managed(
  "runs cancel",
  "Cancel managed work",
  z.object({ runID: z.string(), status: z.string(), changed: z.boolean() }),
  true,
  "required",
  false,
  "daemon",
);
for (const action of ["save", "restore"])
  managed(
    "slots " + action,
    action + " a slot prompt cache on disk",
    z.object({
      slotID: z.string(),
      action: z.string(),
      changed: z.boolean(),
      directory: z.string(),
    }),
    true,
    "required",
    false,
    "daemon",
  );
export const commandDefinitions: readonly Definition[] = definitions;
export const getCommand = (name: string) =>
  definitions.find((d) => d.name === name);
export const commandCatalog = () =>
  definitions
    .map(({ handler, request, result, ...d }) => ({
      ...d,
      requestSchema: d.name.replaceAll(" ", ".") + ".request",
      resultSchema: d.name.replaceAll(" ", ".") + ".result",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
export function help(scope = "") {
  const catalog = commandCatalog().filter(
    (d) => !scope || d.name === scope || d.name.startsWith(scope + " "),
  );
  if (scope && !catalog.length) throw invalidInput("Unknown help scope");
  return {
    scope,
    commands: catalog.map((d) => d.name),
    definitions: catalog,
    options: Object.keys(globalOptions).map((s) => "--" + s),
    schemaVersion: SCHEMA_VERSION,
  };
}
export function exportSchemas(): Record<
  string,
  Record<string, z.infer<ReturnType<typeof z.json>>>
> {
  const out: Record<
    string,
    Record<string, z.infer<ReturnType<typeof z.json>>>
  > = {};
  for (const d of definitions) {
    const prefix = d.name.replaceAll(" ", ".");
    out[prefix + ".request"] = z.toJSONSchema(d.request, {
      io: "input",
    }) as Record<string, z.infer<ReturnType<typeof z.json>>>;
    out[prefix + ".result"] = z.toJSONSchema(d.result) as Record<
      string,
      z.infer<ReturnType<typeof z.json>>
    >;
  }
  out["envelope.success"] = z.toJSONSchema(successEnvelopeSchema) as Record<
    string,
    z.infer<ReturnType<typeof z.json>>
  >;
  out["envelope.error"] = z.toJSONSchema(errorEnvelopeSchema) as Record<
    string,
    z.infer<ReturnType<typeof z.json>>
  >;
  return Object.fromEntries(
    Object.entries(out).sort(([a], [b]) => a.localeCompare(b)),
  );
}
