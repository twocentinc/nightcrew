import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { runExecutable } from "./execution.js";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  id,
  skillSchema,
  skillLoadInputSchema,
  type Skill,
} from "./contracts.js";
import { readJSON } from "./storage.js";
import { readSkillFiles } from "./skills.js";
const validators = new Map<string, z.ZodType>();
function toolValidator(parameters: ToolDefinition["parameters"]) {
  const key = JSON.stringify(parameters);
  let validator = validators.get(key);
  if (!validator) {
    validator = z.fromJSONSchema(parameters);
    if (validators.size >= 256)
      validators.delete(validators.keys().next().value!);
  } else validators.delete(key);
  validators.set(key, validator);
  return validator;
}
export const toolDefinitionSchema = z
  .strictObject({
    toolID: id,
    description: z.string().min(1).max(2000),
    parameters: z.record(z.string(), z.json()),
    executablePath: z
      .string()
      .refine(path.isAbsolute, "Executable path must be absolute"),
    argv: z
      .array(
        z
          .string()
          .max(4000)
          .describe(
            "One process argument. Supports %parameter% and %nested.path%; %% is a literal percent. Substituted values remain one argument.",
          ),
      )
      .max(64)
      .default([]),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
  })
  .superRefine((value, ctx) => {
    if (value.parameters.type !== "object")
      ctx.addIssue({
        code: "custom",
        message: "Tool parameters must be an object JSON Schema",
      });
    try {
      toolValidator(value.parameters);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Unsupported parameters schema",
      });
    }
  });
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
const parameters = {
  load_skills: z.toJSONSchema(skillLoadInputSchema),
  runs_list: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 100 } },
    additionalProperties: false,
  },
  runs_transcript: {
    type: "object",
    properties: {
      runID: { type: "string" },
      offset: { type: "integer", minimum: 0 },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["runID"],
    additionalProperties: false,
  },
};
export const builtinTools: ToolDefinition[] = (
  ["load_skills", "runs_list", "runs_transcript"] as const
).map((name) =>
  toolDefinitionSchema.parse({
    toolID: name,
    executablePath: process.execPath,
    argv: [fileURLToPath(new URL("./toolCommands.js", import.meta.url)), name],
    description: {
      load_skills:
        'Read instructions with {"skillIDs":["ID"]}. Do not put instructions or SKILL.md in files. Read references/assets only using paths returned by the skill manifest.',
      runs_list:
        "List prior terminal runs of this agent, newest first; excludes the current run.",
      runs_transcript:
        "Read a bounded page of a prior run belonging to this agent. Do not reread the current active conversation.",
    }[name],
    parameters: parameters[name],
  }),
);
// Read compatibility only: new command requests must use the executable-only schema.
// Historical snapshots retain their original bytes; conversion happens at execution.
export function normalizeStoredTool(value: unknown): ToolDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return toolDefinitionSchema.parse(value);
  const {
    adapter,
    readOnly,
    arguments: legacyArgv,
    ...rest
  } = value as Record<string, unknown>;
  if (
    legacyArgv !== undefined &&
    rest.argv !== undefined &&
    JSON.stringify(legacyArgv) !== JSON.stringify(rest.argv)
  )
    throw Error("Conflicting legacy arguments and argv");
  const executable = {
    ...rest,
    ...(rest.argv === undefined && legacyArgv !== undefined
      ? { argv: legacyArgv }
      : {}),
  };
  if (adapter === undefined || adapter === "exec")
    return toolDefinitionSchema.parse(executable);
  const bundled = builtinTools.find((t) => t.toolID === adapter);
  if (!bundled) throw Error("Unknown legacy tool adapter");
  return toolDefinitionSchema.parse({
    ...executable,
    executablePath: bundled.executablePath,
    argv: bundled.argv,
  });
}
export async function loadRegistry(home: string) {
  const skills = new Map<string, Skill>();
  const tools = new Map(builtinTools.map((t) => [t.toolID, t]));
  for (const kind of ["skills", "tools"]) {
    const root = path.join(home, kind);
    try {
      const stat = await lstat(root);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Invalid registry directory");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (kind === "skills" && entry.isSymbolicLink())
        throw Error("Skill folders cannot be symlinks");
      if (kind === "tools" && entry.name.endsWith(".json")) {
        const name = id.parse(entry.name.slice(0, -5));
        const tool = normalizeStoredTool(
          await readJSON(path.join(root, entry.name), z.unknown(), 128 * 1024),
        );
        if (tool.toolID !== name || tools.has(name))
          throw Error("Conflicting tool identity");
        tools.set(name, tool);
      }
      if (kind === "skills" && entry.isDirectory()) {
        id.parse(entry.name);
        const file = path.join(root, entry.name, "SKILL.md");
        const stat = await lstat(file).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "ENOENT") return null;
          throw e;
        });
        if (!stat) continue;
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20000)
          throw Error("Invalid skill file");
        const text = await readFile(file, "utf8");
        const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
        if (!match) throw Error("Invalid skill frontmatter");
        const field = (name: string) => {
          const value =
            new RegExp("^" + name + ":\\s*(.+)$", "m").exec(match[1]!)?.[1] ??
            "";
          try {
            return JSON.parse(value);
          } catch {
            return value;
          }
        };
        const skill = skillSchema.parse({
          skillID: entry.name,
          name: field("name"),
          description: field("description"),
          instructions: match[2],
          files: await readSkillFiles(path.join(root, entry.name)),
          toolIDs: [...match[1]!.matchAll(/^\s+-\s+([\w-]+)\s*$/gm)].map(
            (m) => m[1],
          ),
        });
        skills.set(entry.name, skill);
      }
    }
  }
  return { skills, tools };
}
export function validateRegistry(
  agents: { skillIDs: string[]; toolIDs: string[] }[],
  skills: Map<string, Skill>,
  tools: Map<string, ToolDefinition>,
) {
  for (const skill of skills.values())
    for (const tool of skill.toolIDs)
      if (!tools.has(tool)) throw Error("Skill references an unknown tool");
  for (const agent of agents) {
    for (const name of agent.toolIDs)
      if (!tools.has(name)) throw Error("Agent references an unknown tool");
    for (const name of agent.skillIDs) {
      const skill = skills.get(name);
      if (!skill) throw Error("Agent references an unknown skill");
      if (
        skill.toolIDs.some(
          (t) => t !== "load_skills" && !agent.toolIDs.includes(t),
        )
      )
        throw Error("Skill tools must be allowed by the agent");
    }
  }
}
// Substitute into individual argv entries, never a shell command or a second template.
export function resolveToolArgv(
  templates: string[],
  parameters: unknown,
): string[] {
  return templates.map((template) => {
    const argument = template.replace(
      /%%|%([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)%/g,
      (match, name: string | undefined) => {
        if (match === "%%") return "%";
        let value: unknown = parameters;
        for (const key of name!.split(".")) {
          if (
            value === null ||
            typeof value !== "object" ||
            !Object.hasOwn(value, key)
          )
            throw Error("Missing tool parameter for argv: " + name);
          value = (value as Record<string, unknown>)[key];
        }
        if (value === undefined)
          throw Error("Missing tool parameter for argv: " + name);
        return typeof value === "string" ? value : JSON.stringify(value);
      },
    );
    if (argument.includes("\0")) throw Error("Tool argv cannot contain NUL");
    if (argument.length > 4000)
      throw Error("Expanded tool argv entry exceeds 4000 characters");
    return argument;
  });
}
export async function executeExternalTool(
  tool: ToolDefinition,
  input: unknown,
  signal: AbortSignal,
  context?: {
    home: string;
    agentID?: string;
    runID?: string;
    skills?: Skill[];
  },
) {
  const validated = toolValidator(tool.parameters).parse(input);
  signal.throwIfAborted();
  const argv = resolveToolArgv(tool.argv, validated);
  return executeValidatedTool(tool, validated, argv, signal, context);
}
async function executeValidatedTool(
  tool: ToolDefinition,
  validated: unknown,
  argv: string[],
  signal: AbortSignal,
  context: Parameters<typeof executeExternalTool>[3],
) {
  const output = await runExecutable({
    executable: tool.executablePath,
    argv,
    input: JSON.stringify(validated) + "\n",
    timeoutMs: tool.timeoutMs,
    signal,
    extraInputs: context?.skills ? [JSON.stringify(context.skills)] : undefined,
    env: {
      PATH: process.env.PATH ?? "",
      ...(context
        ? {
            NIGHTCREW_HOME: context.home,
            ...(context.agentID ? { NIGHTCREW_AGENT_ID: context.agentID } : {}),
            ...(context.runID ? { NIGHTCREW_RUN_ID: context.runID } : {}),
            ...(context.skills ? { NIGHTCREW_SKILLS_FD: "3" } : {}),
          }
        : {}),
    },
    errors: {
      timeout: "Tool timed out",
      interrupted: "Tool interrupted",
      limit: "Tool output limit",
      failed: "External tool failed",
    },
  });
  try {
    return JSON.parse(output.toString("utf8"));
  } catch {
    throw Error("Tool must return JSON");
  }
}

// Model mistakes and executable failures are conversation results, not run failures.
// Keep process/storage cancellation outside this boundary and never replay a call.
export async function executeModelTool(
  tool: ToolDefinition | undefined,
  args: string,
  signal: AbortSignal,
  context?: Parameters<typeof executeExternalTool>[3],
) {
  signal.throwIfAborted();
  const failure = (
    code: string,
    message: string,
    outcome: "not_started" | "unknown",
  ) => ({
    ok: false,
    error: { code, message, outcome },
  });
  if (!tool)
    return failure(
      "tool_unavailable",
      "This tool is unavailable or not allowed. Choose an advertised tool.",
      "not_started",
    );
  let input: unknown;
  let argv: string[];
  try {
    input = JSON.parse(args);
    input = toolValidator(tool.parameters).parse(input);
    argv = resolveToolArgv(tool.argv, input);
  } catch (error) {
    return failure(
      "invalid_tool_arguments",
      "Arguments must be valid JSON matching the tool schema, including required argv parameters. Correct the arguments before trying again." +
        (error instanceof z.ZodError
          ? " Validation: " +
            JSON.stringify(
              error.issues.slice(0, 4).map(({ path, message }) => ({
                path,
                message,
              })),
            ).slice(0, 2000)
          : "") +
        (tool.toolID === "load_skills"
          ? ' Read instructions with {"skillIDs":["ID"]}, not a file named instructions or SKILL.md.'
          : ""),
      "not_started",
    );
  }
  try {
    const result = await executeValidatedTool(
      tool,
      input,
      argv,
      signal,
      context,
    );
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const reason = error instanceof Error ? error.message : "";
    const code =
      reason === "Tool timed out"
        ? "tool_timeout"
        : reason === "Tool output limit"
          ? "tool_output_limit"
          : reason === "Tool must return JSON"
            ? "invalid_tool_output"
            : "tool_execution_failed";
    return failure(
      code,
      "The tool did not return a successful JSON result. Continue with other available evidence or report the limitation. The action may have taken effect; verify before repeating any side effect." +
        (tool.toolID === "load_skills"
          ? ' To read instructions, use {"skillIDs":["ID"]}; only request resource paths listed in the returned manifest.'
          : ""),
      "unknown",
    );
  }
}
