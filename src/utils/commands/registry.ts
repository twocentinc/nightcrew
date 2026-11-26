import type { OptionBindings } from "./definition.js";
import path from "node:path";
import { z } from "zod";
import {
  checkpoint,
  diagnostic,
  remainingTimeout,
} from "../../engine/execution/process.js";
import { LlamaRuntime, samplePresence } from "../../engine/models/runtime.js";
import {
  NightcrewError,
  SCHEMA_VERSION,
  errorEnvelopeSchema,
  invalidInput,
  successEnvelopeSchema,
} from "../../engine/protocol.js";
import { Service } from "../../engine/service.js";
import { storeSchema } from "../../schemas/config.js";
import { control } from "../../server/daemon.js";
import { readJSON } from "../../storage/files.js";
import { Storage } from "../../storage/store.js";
import { registerLocal as registerdaemon } from "../../commands/daemon.js";
import { registerLocal as registerhelp } from "../../commands/help.js";
import { registerLocal as registerinit } from "../../commands/init.js";
import { requestSchemas } from "./inputs.js";
import { type ManagementInput } from "./management.js";
import { callOperation, operationDefinitions } from "./operations.js";
import { registerLocal as registerpresence } from "../../commands/presence.js";
import { registerLocal as registerschema } from "../../commands/schema.js";
import { registerLocal as registerversion } from "../../commands/version.js";

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
  operand: "none" | "required" | "optional" | "scope";
  mutates: boolean;
  confirmation: boolean;
  options: string[];
  bindings: OptionBindings;
  request: z.ZodType;
  result: z.ZodType;
  handler: (context: CommandContext) => Promise<unknown>;
};
const empty = z.strictObject({});

export const globalOptions = {
  home: "absolute-path",
  "request-id": "ID",
  timeout: "duration",
  quiet: false,
  verbosity: "quiet|normal|verbose|debug",
  "no-input": false,
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
    bindings?: OptionBindings;
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
    bindings: extras.bindings ?? {},
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
    if (
      (e as { code?: string }).code === "OFFLINE" &&
      name === "status" &&
      (context.request as { doctor?: boolean }).doctor
    ) {
      const { doctor } = await import("../../server/diagnostics.js");
      return doctor(context.home, true, async () => {
        throw e;
      });
    }
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
        contextCache: (contextID, reset, dryRun) =>
          new LlamaRuntime(
            () => storage.store.config,
            context.home,
          ).contextCache(contextID, reset, dryRun),
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

export type Define = typeof define;
registerhelp(define);
registerversion(define);
registerschema(define);
registerinit(define);
registerpresence(define);
registerdaemon(define);
for (const operation of operationDefinitions) {
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
    ["agents run", "evals run", "instant create"].includes(name)
      ? z.union([
          result,
          operationDefinitions.find(
            (d) =>
              d.name ===
              (name === "instant create" ? "instant get" : "runs get"),
          )!.result,
        ])
      : result,
    (c) => management(c, name, scope),
    {
      confirmation,
      bindings: operation.bindings,
      options: [
        ...options,
        ...(["agents run", "evals run", "instant create"].includes(name)
          ? ["wait"]
          : name === "runs transcript"
            ? ["tail"]
            : []),
      ],
      request,
    },
  );
}
export const commandDefinitions: readonly Definition[] = definitions;
export const getCommand = (name: string) =>
  definitions.find((d) => d.name === name);
export const commandCatalog = () =>
  definitions
    .map(({ handler, request, result, bindings, ...d }) => ({
      ...d,
      requestSchema: d.name.replaceAll(" ", ".") + ".request",
      resultSchema: d.name.replaceAll(" ", ".") + ".result",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
export const advancedCommands = new Set([
  "agents cache delete",
  "runs verify",
  "schema get",
  "config token rotate",
  "presence sample",
  "config reload",
]);
export function help(scope = "", advanced = false) {
  const catalog = commandCatalog().filter((d) =>
    !scope
      ? advanced || !advancedCommands.has(d.name)
      : d.name === scope || d.name.startsWith(scope + " "),
  );
  if (scope && !catalog.length) throw invalidInput("Unknown help scope");
  return {
    scope,
    commands: catalog.map((d) => d.name),
    ...(catalog.some((d) => d.name === scope) ? { definitions: catalog } : {}),
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
