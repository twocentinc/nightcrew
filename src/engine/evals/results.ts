import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  checkpoint,
  executionSignal,
  remainingTimeout,
  runExecutable,
} from "../execution/process.js";
import { evalGraderSchema, evalGradeSchema, EvalSuite } from "./format.js";
import { digest } from "./runner.js";

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
export async function snapshotGrader(grader: z.infer<typeof evalGraderSchema>) {
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
export function checkEvalAnswer(
  c: EvalSuite["cases"][number],
  answer: string,
  counts: Record<string, number>,
) {
  return c.expectations.assertions.map((a) => {
    let passed = false;
    if (a.type === "finalContains") passed = answer.includes(a.text);
    if (a.type === "finalNotContains") passed = !answer.includes(a.text);
    if (a.type === "mockCallCount")
      passed =
        (counts[a.mockID] ?? 0) >= a.min && (counts[a.mockID] ?? 0) <= a.max;
    if (a.type === "finalJSONSchema") {
      try {
        passed = z
          .fromJSONSchema(a.schema)
          .safeParse(JSON.parse(answer)).success;
      } catch {}
    }
    return { assertionID: a.assertionID, passed };
  });
}
export async function gradeCase({
  record,
  graders,
  suite,
  c,
  snapshot,
  answer,
  counts,
  save,
}: {
  record: Record<string, unknown>;
  graders: Awaited<ReturnType<typeof snapshotGrader>>[];
  suite: EvalSuite;
  c: EvalSuite["cases"][number];
  snapshot: unknown;
  answer: string;
  counts: Record<string, number>;
  save: () => Promise<void>;
}) {
  const executionStatus = record.status;
  if (graders.length) {
    record.gradingComplete = false;
    if (executionStatus === "passed") record.status = "needs_review";
  }
  await save();
  const grades: Array<Record<string, unknown>> = [];
  record.graders = grades;
  const reviewed = new Map<string, string>();
  let graderError = false,
    graderFailed = false,
    graderNeedsReview = false;
  for (const grader of graders) {
    try {
      checkpoint();
      for (const original of grader.files) {
        const current = await hashGraderFile(original.path);
        if (
          current.sha256 !== original.sha256 ||
          current.resolvedPath !== original.resolvedPath
        )
          throw Error("Grader changed after snapshot");
      }
      const input = JSON.stringify({
        version: 1,
        suiteID: suite.suiteID,
        graderID: grader.graderID,
        case: c,
        snapshot,
        result: { ...record, graders: undefined, status: executionStatus },
      });
      if (Buffer.byteLength(input) > 16 * 1024 * 1024)
        throw Error("Grader input limit");
      const output = await runExecutable({
        executable: grader.executablePath,
        argv: grader.argv,
        input,
        env: { PATH: process.env.PATH ?? "" },
        timeoutMs: remainingTimeout(grader.timeoutMs),
        signal: executionSignal(),
        errors: {
          timeout: "Grader timed out",
          interrupted: "Grader interrupted",
          limit: "Grader output limit",
          failed: (code, signal) =>
            "Grader process failed (exit " + code + ", signal " + signal + ")",
        },
      });
      const grade = evalGradeSchema.parse(JSON.parse(output.toString("utf8")));
      for (const check of grade.checks)
        if (
          check.criterionID &&
          !c.expectations.criteria.some(
            (x) => x.criterionID === check.criterionID,
          )
        )
          throw Error("Unknown grader criterionID: " + check.criterionID);
      for (const check of grade.checks) {
        graderFailed ||= check.status === "failed";
        graderNeedsReview ||= check.status === "needs_review";
        if (check.criterionID) {
          const old = reviewed.get(check.criterionID);
          reviewed.set(
            check.criterionID,
            old === "failed" || check.status === "failed"
              ? "failed"
              : old === "needs_review" || check.status === "needs_review"
                ? "needs_review"
                : "passed",
          );
        }
      }
      grades.push({
        graderID: grader.graderID,
        identityHash: grader.identityHash,
        status: "completed",
        ...grade,
      });
    } catch (error) {
      graderError = true;
      grades.push({
        graderID: grader.graderID,
        identityHash: grader.identityHash,
        status: "error",
        error:
          error instanceof Error
            ? error.message.slice(0, 2000)
            : "Grader failed",
      });
    }
    await save();
  }
  if (graders.length) record.gradingComplete = true;
  record.criteria = c.expectations.criteria.map((criterion) => ({
    ...criterion,
    status: reviewed.get(criterion.criterionID) ?? "unreviewed",
  }));
  if (graderError) {
    record.status = "error";
    record.error ??= "grader_error";
  } else if (executionStatus !== "error") {
    const checks = checkEvalAnswer(c, answer, counts);
    record.status =
      checks.some((x) => !x.passed) || graderFailed
        ? "failed"
        : graderNeedsReview ||
            c.expectations.criteria.some((x) => !reviewed.has(x.criterionID)) ||
            (!checks.length && !grades.length)
          ? "needs_review"
          : "passed";
  }
  await save();
}
