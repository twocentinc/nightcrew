import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { checkpoint, runExecutable } from "../execution/process.js";
import { graderExecSchema, gradeSchema } from "./format.js";
import { fingerprint as digest } from "../../utils/json.js";

export async function hashGraderFile(file: string) {
  const resolvedPath = await realpath(file),
    info = await stat(resolvedPath);
  if (!info.isFile() || info.size > 256 * 1024 * 1024)
    throw Error("Invalid or oversized grader file");
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(resolvedPath)) {
    checkpoint();
    hash.update(chunk);
  }
  return { path: file, resolvedPath, sha256: hash.digest("hex") };
}
export async function snapshotGrader(grader: z.infer<typeof graderExecSchema>) {
  const paths = new Set([grader.executablePath, ...grader.sourceFiles]);
  // Capture script arguments automatically; declared sourceFiles cover imports/data.
  for (const arg of grader.argv) {
    if (arg.startsWith("-")) continue;
    const file = path.resolve(arg);
    if ((await stat(file).catch(() => null))?.isFile()) paths.add(file);
  }
  const files = await Promise.all([...paths].map(hashGraderFile));
  const snapshot = { ...grader, workingDirectory: process.cwd(), files };
  return { ...snapshot, identityHash: digest(snapshot) };
}

import type { Run } from "../../schemas/run.js";
import { encodeRun } from "../../schemas/run.js";
import { now } from "../../schemas/common.js";
import { parseOutputJSON } from "../supervision.js";
export async function gradeRun(run: Run): Promise<z.infer<typeof gradeSchema>> {
  const evaluation = run.evaluation!;
  const startedAt = now();
  const finish = (
    value: Omit<z.infer<typeof gradeSchema>, "startedAt" | "finishedAt">,
  ) => ({ ...value, startedAt, finishedAt: now() });
  if (run.state !== "completed")
    return finish({
      status: "failed",
      reason: "Execution did not complete successfully",
    });
  const latestValidation = [...run.validations]
    .reverse()
    .find((v) => v.turnID === run.turnID);
  if (latestValidation && latestValidation.status !== "passed")
    return finish({
      status: "failed",
      reason: "Agent output validation failed",
    });
  const grader = evaluation.definition.grader;
  if (!grader) return finish({ status: "ungraded" });
  let result: unknown = run.result;
  if (run.agent.finishSchema) {
    const completed = [...run.events]
      .reverse()
      .find((e) => e.type === "completed" && e.turnID === run.turnID);
    const messageID =
      completed && "messageID" in completed.data
        ? completed.data.messageID
        : undefined;
    const final = run.messages.find((m) => m.messageID === messageID);
    if (!final)
      return finish({
        status: "error",
        reason: "Missing accepted finish result",
      });
    result = parseOutputJSON(final.content);
  }
  let schema: z.infer<typeof gradeSchema>["schema"];
  if (grader.schema) {
    const parsed = z.fromJSONSchema(grader.schema).safeParse(result);
    schema = {
      passed: parsed.success,
      issues: parsed.success
        ? []
        : parsed.error.issues
            .slice(0, 100)
            .map((i) => ({ path: i.path.join("."), message: i.message })),
    };
    if (!parsed.success)
      return finish({
        status: "failed",
        schema,
        reason: "Finish result does not satisfy the expected schema",
      });
  }
  if (!grader.exec) return finish({ status: "passed", schema });
  try {
    const snapshot = evaluation.grader;
    if (!snapshot) throw Error("Missing grader identity snapshot");
    for (const original of snapshot.files) {
      const current = await hashGraderFile(original.path);
      if (
        current.sha256 !== original.sha256 ||
        current.resolvedPath !== original.resolvedPath
      )
        throw Error("Grader changed after run admission");
    }
    const input = JSON.stringify({
      eval: evaluation.definition,
      run: encodeRun(run),
      result,
    });
    if (Buffer.byteLength(input) > 64 * 1024 * 1024)
      throw Error("Grader input exceeds 64 MB");
    const output = await runExecutable({
      executable: snapshot.executablePath,
      argv: snapshot.argv,
      cwd: snapshot.workingDirectory,
      input,
      env: { PATH: process.env.PATH ?? "" },
      timeoutMs: snapshot.timeoutMs,
      errors: {
        timeout: "Grader timed out",
        interrupted: "Grader interrupted",
        limit: "Grader output limit",
        failed: (code, signal) =>
          `Grader failed (${code}, ${signal ?? "none"})`,
      },
    });
    const exec = z
      .strictObject({
        passed: z.boolean(),
        reason: z.string().min(1).max(8000),
      })
      .parse(JSON.parse(output.toString("utf8")));
    return finish({ status: exec.passed ? "passed" : "failed", schema, exec });
  } catch (error) {
    return finish({
      status: "error",
      schema,
      reason:
        error instanceof Error ? error.message.slice(0, 8000) : "Grader failed",
    });
  }
}
