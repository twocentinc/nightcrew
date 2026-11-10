import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import { id, skillSchema, type Skill } from "./contracts.js";
import { readJSON } from "./storage.js";
export const builtinAdapter = z.enum([
  "load_skills",
  "runs_list",
  "runs_transcript",
]);
export const toolDefinitionSchema = z
  .strictObject({
    toolID: id,
    description: z.string().min(1).max(2000),
    adapter: z.enum(["load_skills", "runs_list", "runs_transcript", "exec"]),
    parameters: z.record(z.string(), z.json()),
    readOnly: z.literal(true),
    executablePath: z.string().optional(),
    arguments: z.array(z.string().max(4000)).max(64).default([]),
    timeoutMs: z.number().int().min(100).max(60000).default(10000),
  })
  .superRefine((value, ctx) => {
    if (value.adapter === "exec") {
      if (value.parameters.type !== "object")
        ctx.addIssue({
          code: "custom",
          message: "Tool parameters must be an object JSON Schema",
        });
      if (!value.executablePath || !path.isAbsolute(value.executablePath))
        ctx.addIssue({
          code: "custom",
          message: "External tools require an absolute executablePath",
        });
      try {
        z.fromJSONSchema(value.parameters);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Unsupported parameters schema",
        });
      }
    } else if (value.executablePath || value.arguments.length)
      ctx.addIssue({
        code: "custom",
        message: "Builtin adapters cannot specify executables",
      });
  });
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
const parameters = {
  load_skills: {
    type: "object",
    properties: {
      skillIDs: { type: "array", items: { type: "string" }, maxItems: 40 },
    },
    required: ["skillIDs"],
    additionalProperties: false,
  },
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
export const builtinTools: ToolDefinition[] = builtinAdapter.options.map(
  (adapter) =>
    toolDefinitionSchema.parse({
      toolID: adapter,
      adapter,
      description: {
        load_skills: "Read selected skill instructions.",
        runs_list: "List recent runs of this agent.",
        runs_transcript: "Read a page of a run belonging to this agent.",
      }[adapter],
      parameters: parameters[adapter],
      readOnly: true,
    }),
);
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
      if (kind === "tools" && entry.name.endsWith(".json")) {
        const name = id.parse(entry.name.slice(0, -5));
        const tool = await readJSON(
          path.join(root, entry.name),
          toolDefinitionSchema,
          128 * 1024,
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
      if (skill.toolIDs.some((t) => !agent.toolIDs.includes(t)))
        throw Error("Skill tools must be allowed by the agent");
    }
  }
}
export async function executeExternalTool(
  tool: ToolDefinition,
  input: unknown,
  signal: AbortSignal,
) {
  const validated = z.fromJSONSchema(tool.parameters).parse(input);
  signal.throwIfAborted();
  return new Promise<unknown>((resolve, reject) => {
    const child = spawn(tool.executablePath!, tool.arguments, {
      stdio: ["pipe", "pipe", "ignore"],
      detached: true,
      env: { PATH: process.env.PATH ?? "" },
    });
    const output: Buffer[] = [];
    let bytes = 0;
    let error: Error | undefined;
    const stop = (reason: string) => {
      error = Error(reason);
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
    };
    const aborted = () => stop("Tool interrupted");
    const timer = setTimeout(() => stop("Tool timed out"), tool.timeoutMs);
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    child.stdout.on("data", (chunk: Buffer) => {
      if (bytes + chunk.length > 1048576) stop("Tool output limit");
      else {
        output.push(chunk);
        bytes += chunk.length;
      }
    });
    child.stdin.on("error", () => {});
    child.once("error", (e) => {
      error = e;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      if (error || code !== 0) {
        reject(Error(error?.message ?? "External tool failed"));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(output).toString("utf8")));
      } catch {
        reject(Error("Tool must return JSON"));
      }
    });
    child.stdin.end(JSON.stringify(validated) + "\n");
  });
}
