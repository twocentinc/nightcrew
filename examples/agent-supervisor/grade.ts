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
  const answer = input.result.answer;
  const issues = new Map<
    string,
    { runID: string; execution: string; output: string; delivery: string }
  >();
  for (const message of input.result.messages) {
    if (message.role !== "tool") continue;
    try {
      const value = JSON.parse(message.content);
      for (const issue of value.result?.coverage?.priorityIssues ??
        value.coverage?.priorityIssues ??
        [])
        issues.set(issue.runID, issue);
    } catch {
      /* Plain-text fixture responses are allowed. */
    }
  }
  const checks: Check[] = [];
  const parts = answer
    .replace(/```[\s\S]*?```/g, "")
    .split(/^###\s+(.+?)\s*$/m);
  for (const [runID, issue] of issues) {
    const index = parts.findIndex(
      (text, i) => i % 2 === 1 && text.trim() === runID,
    );
    const body =
      index >= 0 ? ((parts[index + 1] ?? "").split(/^#{1,3}\s/m)[0] ?? "") : "";
    const present = Object.entries({
      Execution: issue.execution,
      Output: issue.output,
      Delivery: issue.delivery,
    }).every(([key, value]) =>
      body.split(/\r?\n/).some((line) => line.trim() === `${key}: ${value}`),
    );
    checks.push({
      checkID: "coverage-" + runID,
      status:
        present &&
        /^Assessment: .{20,}$/m.test(body) &&
        /^Next action: .{10,}$/m.test(body)
          ? "passed"
          : "failed",
      reason:
        "Report must explicitly assess this priority incident using its supplied statuses: " +
        runID,
    });
  }
  if (!checks.length)
    checks.push({
      checkID: "nonempty-report",
      status: answer.trim() ? "passed" : "failed",
      reason: "The agent must produce a report.",
    });
  for (const criterion of input.case.expectations.criteria)
    checks.push({
      checkID: criterion.criterionID,
      criterionID: criterion.criterionID,
      status: "needs_review",
      reason:
        "Requires semantic review of the trace and report: " +
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
