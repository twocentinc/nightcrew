import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type Check = {
  checkID: string;
  status: "passed" | "failed" | "needs_review";
  reason: string;
  criterionID?: string;
};
export type Input = {
  version: 1;
  case: {
    caseID: string;
    expectations: {
      criteria: Array<{ criterionID: string; description: string }>;
    };
  };
  result: {
    answer: string;
    status: string;
    messages: Array<{ role: string; content: string }>;
  };
};
export function grade(input: Input): { checks: Check[] } {
  let summary = "";
  try {
    const value = JSON.parse(input.result.answer);
    if (typeof value.summary === "string") summary = value.summary;
  } catch {}
  const checks: Check[] = [
    {
      checkID: "summary-present",
      status: summary.trim() ? "passed" : "failed",
      reason: "Final JSON must contain a nonempty summary string.",
    },
  ];
  if (input.case.caseID === "budget-not-invented")
    checks.push({
      checkID: "budget-literal",
      status: summary.includes("$50/day") ? "passed" : "failed",
      reason: "Preserve the exact supplied budget $50/day.",
    });
  if (input.case.caseID === "timestamp-not-a-count")
    checks.push({
      checkID: "timestamp-literal",
      status: summary.includes("2026-11-11T05:42:35.293Z")
        ? "passed"
        : "failed",
      reason: "Preserve the exact timestamp for the next query.",
    });
  for (const criterion of input.case.expectations.criteria)
    checks.push({
      checkID: criterion.criterionID,
      criterionID: criterion.criterionID,
      status: "needs_review",
      reason:
        "Literal preservation alone does not establish meaning: " +
        criterion.description,
    });
  return { checks };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16 * 1024 * 1024)
      throw Error("Grader input limit");
  }
  console.log(JSON.stringify(grade(JSON.parse(input))));
}
