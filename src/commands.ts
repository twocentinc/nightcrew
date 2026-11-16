import { evalSuiteSchema, evalRunSchema, evalRunResultSchema, runEval } from "./evals.js";
import { requestSchemas } from "./operationInputs.js";
import { operationDefinitions, callOperation } from "./operations.js";
import path from "node:path";
import { z } from "zod";
import { Storage, initializeHome, readJSON } from "./storage.js";
import { Service } from "./service.js";
import { type ManagementInput } from "./management.js";
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
  packageVersion,
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  invalidInput,
  NightcrewError,
  errorEnvelopeSchema,
  successEnvelopeSchema,
} from "./protocol.js";
import {
  remainingTimeout,
  pause,
  checkpoint,
  diagnostic,
} from "./execution.js";
import { configSchema, storeSchema, statusSchema } from "./contracts.js";
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
const adminConfig = configSchema.omit({ rootTokenHash: true });
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
  advanced: false,
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
      if (name.startsWith("runs ")) await storage.reconcile();
      checkpoint();
      return await callOperation(service, input);
    } finally {
      await storage.close();
    }
  }
}
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
define("evals validate", "Validate an eval suite without inference", "static", "none", false,
  z.object({ suiteID: z.string(), cases: z.number(), valid: z.literal(true) }),
  async c => { const suite = evalSuiteSchema.parse(c.request); return { suiteID: suite.suiteID, cases: suite.cases.length, valid: true }; },
  { request: evalSuiteSchema });
define("evals run", "Run a suite with mocked tools and save a create-only result bundle", "local", "none", true,
  evalRunResultSchema, async c => runEval(c.request, (command, request = {}, resourceID) => control(c.home, { command, request, ...(resourceID ? { resourceID } : {}) }, remainingTimeout(90000)), c.dryRun),
  { request: evalRunSchema });
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
  async (c) => help(c.helpScope ?? c.resourceID ?? "", !!c.values.advanced),
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
    doctor(c.home, !!c.values.live, async (timeout) => {
      const result = await control(c.home, { command: "status" }, timeout) as {pid:number;runtime:object};
      return {pid:result.pid,...result.runtime};
    }),
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
  "restart",
  "logs",
]) {
  const name = "daemon " + action;
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
              { command: "status" },
              remainingTimeout(1000),
            );
            break;
          } catch (e) {
            checkpoint();
            diagnostic("debug", "daemon.waitingForReadiness");
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
for (const operation of operationDefinitions) {
  if (["evals sample", "evals release"].includes(operation.name)) continue;
  const {
    name,
    description,
    scope,
    operand,
    mutates,
    result,
    confirmation,
    options,
    request,
  } = operation;
  define(
    name,
    description,
    scope,
    operand,
    mutates,
    result,
    (c) => management(c, name, scope),
    { confirmation, options, request },
  );
}
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
export const advancedCommands = new Set(["agents cache", "agents reset-cache", "runs verify", "runs retry-hook", "schema get", "auth rotate", "capabilities", "presence sample", "skills reload", "scheduler explain"]);
export function help(scope = "", advanced = false) {
  const catalog = commandCatalog().filter(
    (d) => (!scope ? (advanced || !advancedCommands.has(d.name)) : d.name === scope || d.name.startsWith(scope + " ")),
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
