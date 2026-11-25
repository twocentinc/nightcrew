#!/usr/bin/env node
import { Command, Option } from "commander";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  commandDefinitions,
  getCommand,
  globalOptions,
  type CommandContext,
} from "./utils/commands/registry.js";
import {
  diagnostic,
  Execution,
  executionSignal,
  parseDuration,
  pause,
  type Verbosity,
} from "./engine/execution/process.js";
import {
  errorEnvelopeSchema,
  invalidInput,
  NightcrewError,
  normalizeError,
  packageVersion,
  successEnvelopeSchema,
} from "./engine/protocol.js";
import { tailLogs } from "./server/startup.js";

export { control, runDaemon } from "./server/daemon.js";
export const version = packageVersion;
const optionTypes: Record<string, string | false> = {
  ...globalOptions,
  request: "file-or-dash",
  "dry-run": false,
  yes: false,
  lines: "count",
  limit: "count",
  cursor: "cursor",
  agent: "agentID",
  state: "state",
  live: false,
  details: false,
  wait: false,
  tail: false,
};
export function parseCLI(argv: string[]) {
  const parser = new Command()
    .helpOption(false)
    .addHelpCommand(false)
    .allowExcessArguments(true)
    .configureOutput({ writeOut: () => {}, writeErr: () => {} })
    .exitOverride((error) => {
      throw invalidInput(error.message.replace(/^error: /, ""));
    });
  for (const [name, type] of Object.entries(optionTypes)) {
    const short = name === "help" ? "-h, " : name === "version" ? "-V, " : "";
    parser.addOption(
      new Option(`${short}--${name}${type === false ? "" : " <value>"}`),
    );
  }
  parser.parse(argv, { from: "user" });
  const options = parser.opts<Record<string, string | boolean>>();
  const values = Object.fromEntries(
    parser.options
      .filter((option) => options[option.attributeName()] !== undefined)
      .map((option) => [option.name(), options[option.attributeName()]!]),
  );
  const positional = parser.args;
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
  if (values.quiet && values.verbosity)
    throw invalidInput("Verbosity flags cannot be combined");
  const verbosity = String(
    values.quiet ? "quiet" : (values.verbosity ?? "normal"),
  );
  if ((values.wait || values.tail) && values["dry-run"])
    throw invalidInput("Observation cannot be combined with --dry-run");
  if (values.tail && values.cursor)
    throw invalidInput("--tail cannot be combined with --cursor");
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
    timeoutMs:
      values.tail && !values.timeout
        ? Infinity
        : parseDuration(
            String(
              values.timeout ??
                (selected === "evals run" || values.wait ? "120m" : "90s"),
            ),
            values.wait || values.tail
              ? 86400000
              : selected === "evals run"
                ? 7200000
                : 300000,
          ),
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
  let cleanup = () => {};
  let accepted: { kind: string; id: string } | undefined;
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
    const interrupt = () =>
      execution.controller.abort(
        new NightcrewError(
          "cli.interrupted",
          "Observation interrupted; daemon work was not cancelled",
          1,
          "never",
        ),
      );
    if (args.values.wait || args.values.tail) {
      process.once("SIGINT", interrupt);
      process.once("SIGTERM", interrupt);
      cleanup = () => {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
      };
    }
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
      const raw = await inputJSON(
        args.values.request as string | undefined,
        execution,
      );
      if (command.startsWith("runs ") || command.startsWith("queue ")) {
        for (const [flag, field] of [
          ["limit", "limit"],
          ["cursor", "cursor"],
          ["agent", "agentID"],
          ["state", "state"],
        ]) {
          if (args.values[flag!] !== undefined) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw))
              throw invalidInput("Request must be an object");
            if (raw[field!] !== undefined)
              throw invalidInput("Duplicate request field " + field);
            raw[field!] = args.values[flag!];
          }
        }
      }
      if (command === "status" && args.values.details) raw.details = true;
      context.request = args.definition.request.parse(raw);
      execution.check();
      if (args.definition.confirmation && !context.yes && !context.dryRun)
        throw new NightcrewError(
          "cli.confirmationRequired",
          "Explicit confirmation is required",
          8,
          "never",
          { authorizationFlag: "--yes" },
        );
      if (args.values.tail) {
        if (
          command === "runs transcript" &&
          (context.request as { cursor?: string }).cursor
        )
          throw invalidInput("--tail cannot be combined with a cursor");
        await tailCommand(context, command, async (result) => {
          const line =
            JSON.stringify(
              successEnvelopeSchema.parse({
                version: 1,
                requestID,
                command,
                ok: true,
                result,
              }),
            ) + "\n";
          if (!process.stdout.write(line))
            await once(process.stdout, "drain", { signal: executionSignal() });
        });
        return;
      }
      let output = await args.definition.handler(context);
      if (args.values.wait) {
        const value = output as { runID?: string; requestID?: string };
        accepted = {
          kind: command === "agents run" ? "run" : "instant",
          id: (command === "agents run" ? value.runID : value.requestID)!,
        };
        output = await waitForWork(context, accepted.kind, accepted.id);
      }
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
    const normalized = normalizeError(e, mutation);
    const error = accepted
      ? new NightcrewError(
          normalized.code,
          normalized.message,
          normalized.exitCode,
          "never",
          {
            ...normalized.details,
            outcomeUnknown: false,
            acceptedID: accepted.id,
            kind: accepted.kind,
            cancelled: false,
          },
        )
      : normalized;
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
  } finally {
    cleanup();
  }
}
// These observers use the same command contracts as ordinary CLI requests.
export async function waitForWork(
  context: CommandContext,
  kind: string,
  id: string,
) {
  const definition = getCommand(kind === "run" ? "runs get" : "instant get")!;
  while (true) {
    const output = definition.result.parse(
      await definition.handler({
        ...context,
        resourceID: id,
        request: {},
        values: {},
      }),
    );
    const value = output as { run?: { state: string }; state?: string };
    const state = value.run?.state ?? value.state ?? "";
    if (state === "completed") return output;
    if (["failed", "cancelled", "timedOut"].includes(state))
      throw new NightcrewError(
        "cli.workFailed",
        "Submitted work ended with state " + state,
        1,
        "never",
        { result: z.json().parse(output) },
      );
    await pause(500);
  }
}
export async function tailCommand(
  context: CommandContext,
  command: string,
  emit: (output: unknown) => void | Promise<void>,
) {
  const definition = getCommand(command)!;
  if (command === "daemon logs") {
    for await (const page of tailLogs(
      context.home,
      Number(context.values.lines ?? 100),
    ))
      await emit(definition.result.parse(page));
    return;
  }
  const request = context.request as {
    limit?: number;
    afterSequence?: number;
    recent?: boolean;
  };
  let sequence = request.afterSequence;
  while (true) {
    const output = definition.result.parse(
      await definition.handler({
        ...context,
        request: {
          limit: request.limit ?? 50,
          ...(sequence === undefined
            ? { recent: true }
            : { afterSequence: sequence }),
        },
      }),
    ) as { items: Array<{ sequence: number }> };
    if (output.items.length) await emit(output);
    sequence = output.items.at(-1)?.sequence ?? sequence ?? 0;
    if (output.items.length < (request.limit ?? 50)) await pause(500);
  }
}
if (
  process.argv[1] &&
  (await realpath(process.argv[1]).catch(() => process.argv[1])) ===
    fileURLToPath(import.meta.url)
)
  await main();
