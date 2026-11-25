// Bundled executable tools: ordinary CLI clients, using the same process boundary
// as user tools. Identity is convenience context, not a restricted credential.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { createReadStream } from "node:fs";
import { skillSchema } from "./contracts.js";
import { loadSkillContent } from "./skills.js";
const home = process.env.NIGHTCREW_HOME;
const agentID = process.env.NIGHTCREW_AGENT_ID;
const runID = process.env.NIGHTCREW_RUN_ID;
async function cli(command: string[], request: unknown = {}) {
  if (!home || !agentID || !runID)
    throw Error("Missing Nightcrew tool context");
  return new Promise<any>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../cli.js", import.meta.url)),
        ...command,
        "--home",
        home,
        "--request",
        "-",
      ],
      { stdio: ["pipe", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      if (Buffer.byteLength(output) > 2 * 1024 * 1024) child.kill("SIGKILL");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        const envelope = JSON.parse(output);
        if (code !== 0 || !envelope.ok)
          throw Error(envelope.error?.message ?? "Nightcrew CLI failed");
        resolve(envelope.result);
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify(request) + "\n");
  });
}
async function main() {
  let data = "";
  for await (const chunk of process.stdin) {
    data += chunk;
    if (Buffer.byteLength(data) > 1024 * 1024) throw Error("Tool input limit");
  }
  const input = JSON.parse(data);
  switch (process.argv[2]) {
    case "load_skills": {
      if (process.env.NIGHTCREW_SKILLS_FD === "3") {
        let snapshot = "";
        for await (const chunk of createReadStream("", {
          fd: 3,
          autoClose: true,
        })) {
          snapshot += chunk;
          if (Buffer.byteLength(snapshot) > 24 * 1024 * 1024)
            throw Error("Skill snapshot limit");
        }
        return loadSkillContent(
          z.array(skillSchema).max(40).parse(JSON.parse(snapshot)),
          input,
        );
      }
      const { run } = await cli(["runs", "get", runID!]);
      return loadSkillContent(z.array(skillSchema).parse(run.skills), input);
    }
    case "runs_list": {
      const request = z
        .strictObject({ limit: z.number().int().min(1).max(100).default(20) })
        .parse(input);
      const prior: any[] = [];
      let cursor: string | undefined;
      do {
        const page = await cli(["runs", "list"], {
          agentID,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        prior.push(
          ...page.items.filter(
            (r: any) =>
              r.runID !== runID &&
              ["completed", "failed", "timedOut", "cancelled"].includes(
                r.state,
              ),
          ),
        );
        prior.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        prior.splice(request.limit);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return prior;
    }
    case "runs_transcript": {
      const request = z
        .strictObject({
          runID: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(100).default(20),
        })
        .parse(input);
      const { run } = await cli(["runs", "get", request.runID]);
      if (run.agent.agentID !== agentID)
        throw Error("History belongs to another agent");
      if (
        request.runID === runID &&
        !["completed", "failed", "timedOut", "cancelled"].includes(run.state)
      )
        return {
          ok: false,
          error: {
            code: "current_run_history",
            message:
              "This is your current conversation, already in context. Use runs_list for prior reports; do not reload this transcript.",
          },
        };
      let characters = 0;
      let offset = 0,
        cursor: string | undefined;
      const items: unknown[] = [];
      do {
        const page = await cli(["runs", "transcript", request.runID], {
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        for (const entry of page.items) {
          if (offset++ >= request.offset) {
            // Bound nested tool results and thinking; full evidence remains in the CLI transcript.
            const bounded = JSON.parse(
              JSON.stringify(entry, (_key, value) =>
                typeof value === "string" && value.length > 2000
                  ? value.slice(0, 2000) +
                    " [truncated; use CLI transcript for full evidence]"
                  : value,
              ),
            );
            const size = JSON.stringify(bounded).length;
            if (!items.length && size > 12000) {
              return [
                {
                  truncated: true,
                  entryOffset: offset - 1,
                  preview: JSON.stringify(bounded).slice(0, 10000),
                  nextOffset: offset,
                  message:
                    "Entry exceeds the history budget; preview is partial. Use CLI transcript for full evidence.",
                },
              ];
            }
            if (characters + size > 12000) {
              items.push({
                truncated: true,
                nextOffset: offset - 1,
                message:
                  "History page character budget reached; request nextOffset as offset if needed.",
              });
              return items;
            }
            items.push(bounded);
            characters += size;
          }
          if (items.length >= request.limit) return items;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return items;
    }
    default:
      throw Error("Unknown bundled tool command");
  }
}
main()
  .then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
  .catch((error) => {
    process.stderr.write(
      (error instanceof Error ? error.message : "Tool failed") + "\n",
    );
    process.exitCode = 1;
  });
