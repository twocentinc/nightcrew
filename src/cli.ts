#!/usr/bin/env node
import path from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { readFile, lstat, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  getCommand,
  commandDefinitions,
  globalOptions,
  type CommandContext,
} from "./commands.js";
import {
  packageVersion,
  invalidInput,
  NightcrewError,
  normalizeError,
  successEnvelopeSchema,
  errorEnvelopeSchema,
} from "./protocol.js";
import {
  Execution,
  parseDuration,
  diagnostic,
  type Verbosity,
} from "./execution.js";
export { control, runDaemon } from "./daemon.js";
export const version = packageVersion;
const optionTypes: Record<string, string | false> = {
  ...globalOptions,
  request: "file-or-dash",
  "dry-run": false,
  yes: false,
  lines: "count",
  live: false,
};
const aliases: Record<string, string> = {
  "-h": "--help",
  "-V": "--version",
  "-v": "--verbose",
};
export function parseCLI(argv: string[]) {
  const values: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = aliases[argv[i]!] ?? argv[i]!;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      positional.push(arg);
      continue;
    }
    if (!arg.startsWith("--")) throw invalidInput("Unknown option " + arg);
    const [name, ...rest] = arg.slice(2).split("=");
    const type = optionTypes[name!];
    if (type === undefined) throw invalidInput("Unknown option --" + name);
    if (values[name!] !== undefined)
      throw invalidInput("Repeated option --" + name);
    if (type === false) {
      if (rest.length)
        throw invalidInput("Boolean options do not take a value");
      values[name!] = true;
    } else {
      const value = rest.length ? rest.join("=") : argv[++i];
      if (!value || value.startsWith("--"))
        throw invalidInput("Missing value for --" + name);
      values[name!] = value;
    }
  }
  let selected: string;
  let remaining: string[];
  let helpScope = "";
  if (values.version) {
    selected = "version";
    remaining = [];
  } else if (positional[0] === "help" || values.help || !positional.length) {
    selected = "help";
    remaining = [];
    helpScope = (
      positional[0] === "help" ? positional.slice(1) : positional
    ).join(" ");
  } else {
    const definition = [...commandDefinitions]
      .sort((a, b) => b.name.length - a.name.length)
      .find((d) =>
        d.name.split(" ").every((word, i) => positional[i] === word),
      );
    if (!definition) throw invalidInput("Unknown command");
    selected = definition.name;
    remaining = positional.slice(selected.split(" ").length);
  }
  const definition = getCommand(selected)!;
  if (
    selected !== "help" &&
    remaining.length !== (definition.operand === "required" ? 1 : 0)
  )
    throw invalidInput(
      definition.operand === "required"
        ? "Missing resource ID or unexpected positional arguments"
        : "Unexpected positional arguments",
    );
  const allowed = new Set([
    ...Object.keys(globalOptions),
    ...definition.options,
  ]);
  for (const name of Object.keys(values))
    if (!allowed.has(name))
      throw invalidInput("--" + name + " is not supported by " + selected);
  if (
    (values.quiet && (values.verbose || values.verbosity)) ||
    (values.verbose && values.verbosity)
  )
    throw invalidInput("Verbosity flags cannot be combined");
  const verbosity = String(
    values.quiet
      ? "quiet"
      : values.verbose
        ? "verbose"
        : (values.verbosity ?? "normal"),
  );
  if (!["quiet", "normal", "verbose", "debug"].includes(verbosity))
    throw invalidInput("Invalid verbosity");
  const home = String(
    values.home ??
      process.env.NIGHTCREW_HOME ??
      path.join(homedir(), ".nightcrew"),
  );
  if (!path.isAbsolute(home)) throw invalidInput("--home must be absolute");
  if (
    values.lines !== undefined &&
    (!/^\d+$/.test(String(values.lines)) ||
      Number(values.lines) < 1 ||
      Number(values.lines) > 10000)
  )
    throw invalidInput("--lines must be 1..10000");
  return {
    command: selected,
    definition,
    resourceID: remaining[0],
    helpScope,
    values,
    home,
    timeoutMs: parseDuration(String(values.timeout ?? "90s")),
    verbosity: verbosity as Verbosity,
  };
}
async function inputJSON(source: string | undefined, execution: Execution) {
  execution.check();
  if (!source) return {};
  let text = "";
  if (source === "-") {
    const aborted = () => process.stdin.destroy(execution.signal.reason);
    execution.signal.addEventListener("abort", aborted, { once: true });
    try {
      for await (const chunk of process.stdin) {
        execution.check();
        text += chunk.toString();
        if (Buffer.byteLength(text) > 16 * 1024 * 1024)
          throw invalidInput("Input exceeds 16 MB");
      }
    } finally {
      execution.signal.removeEventListener("abort", aborted);
    }
  } else {
    const stat = await lstat(source);
    execution.check();
    if (!stat.isFile() || stat.size > 16 * 1024 * 1024)
      throw invalidInput("Invalid request file");
    text = await readFile(source, {
      encoding: "utf8",
      signal: execution.signal,
    });
  }
  return JSON.parse(text);
}
export async function main(argv = process.argv.slice(2)) {
  let requestID: string = randomUUID(),
    command = "cli",
    mutation = false;
  try {
    // Preserve correlation even when option or command validation fails.
    const inlineID = argv.find((a) => a.startsWith("--request-id="));
    if (inlineID) requestID = inlineID.slice("--request-id=".length);
    const marker = argv.indexOf("--request-id");
    if (marker >= 0 && argv[marker + 1] && !argv[marker + 1]!.startsWith("-"))
      requestID = argv[marker + 1]!;
    const args = parseCLI(argv);
    command = args.command;
    requestID = String(args.values["request-id"] ?? requestID);
    mutation = args.definition.mutates && !args.values["dry-run"];
    const execution = new Execution(args.timeoutMs, mutation, args.verbosity);
    const context: CommandContext = {
      home: args.home,
      resourceID: args.resourceID,
      helpScope: args.helpScope,
      request: {},
      dryRun: !!args.values["dry-run"],
      yes: !!args.values.yes,
      values: args.values,
    };
    if (command === "daemon run" && !context.dryRun) {
      await args.definition.handler(context);
      return;
    }
    const result = await execution.run(async () => {
      diagnostic("verbose", "command.started", { command, requestID });
      context.request = args.definition.request.parse(
        await inputJSON(args.values.request as string | undefined, execution),
      );
      execution.check();
      if (args.definition.confirmation && !context.yes && !context.dryRun)
        throw new NightcrewError(
          "cli.confirmationRequired",
          "Explicit confirmation is required",
          8,
          "never",
          { authorizationFlag: "--yes" },
        );
      const output = await args.definition.handler(context);
      execution.check();
      let validated;
      try {
        validated = args.definition.result.parse(output);
      } catch {
        throw new NightcrewError(
          "protocol.invalidResult",
          "Command returned a result outside its contract",
          1,
          mutation ? "unsafe" : "safe",
          { outcomeUnknown: mutation },
        );
      }
      diagnostic("verbose", "command.completed", {
        command,
        requestID,
        durationMs: Math.round(performance.now() - execution.started),
      });
      return validated;
    });
    const envelope = successEnvelopeSchema.parse({
      version: 1,
      requestID,
      command,
      ok: true,
      result,
    });
    process.stdout.write(JSON.stringify(envelope) + "\n");
  } catch (e) {
    const error = normalizeError(e, mutation);
    process.stdout.write(
      JSON.stringify(
        errorEnvelopeSchema.parse({
          version: 1,
          requestID,
          command,
          ok: false,
          error: error.toJSON(),
        }),
      ) + "\n",
    );
    process.exitCode = error.exitCode;
  }
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => process.argv[1])) ===
    fileURLToPath(import.meta.url)
)
  await main();
