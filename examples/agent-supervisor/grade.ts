import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type Input = {
  result: unknown;
  run: { messages: Array<{ role: string; content: string }> };
};
export function grade(input: Input) {
  const answer =
    typeof input.result === "string"
      ? input.result
      : String((input.result as { report?: string })?.report ?? "");
  const issues = new Map<
    string,
    { runID: string; execution: string; output: string; delivery: string }
  >();
  for (const message of input.run.messages) {
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
  const checks: Array<{ checkID: string; status: string; reason: string }> = [];
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
  return {
    passed: checks.every((c) => c.status === "passed"),
    reason:
      checks.map((c) => c.reason).join("; ") +
      ". Checks cover status reporting, not causal accuracy.",
  };
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
