import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { Report } from "./report.ts";
export type Input = {
  eval?: { evalID: string };
  result: unknown;
  run: { messages: Array<{ role: string; content: string }> };
};
export function grade(input: Input) {
  const report = input.result as Report;
  if (
    !report ||
    !Array.isArray(report.incidents) ||
    !Array.isArray(report.observations) ||
    !Array.isArray(report.uncertainties)
  )
    return {
      passed: false,
      reason: "Expected a structured supervisor finish result.",
    };
  const issues = new Map<
    string,
    { execution: string; output: string; delivery: string }
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
      /* Non-JSON tool responses do not supply expected statuses. */
    }
  }
  const errors: string[] = [];
  if (
    report.incidents.length !== issues.size ||
    new Set(report.incidents.map((i) => i.runID)).size !==
      report.incidents.length
  )
    errors.push("Incident coverage differs from supplied priorities");
  for (const [id, expected] of issues) {
    const incident = report.incidents.find((i) => i.runID === id);
    if (
      !incident ||
      !["execution", "output", "delivery"].every(
        (key) =>
          incident[key as keyof typeof expected] ===
          expected[key as keyof typeof expected],
      ) ||
      !incident.assessment?.trim() ||
      !incident.nextAction?.trim()
    )
      errors.push(`Missing or incorrect assessment for ${id}`);
  }
  const observations = report.observations.join("\n");
  if (!observations.trim()) errors.push("Missing observations");
  if (
    input.eval?.evalID.endsWith("current-failure-versus-recovered-history") &&
    !report.observations.some(
      (text) =>
        /recovered-child/.test(text) &&
        /recovered-parent/.test(text) &&
        /recover|replacement|no_longer_required/i.test(text),
    )
  )
    errors.push("Explain the child's recovery using the parent evidence");
  if (input.eval?.evalID.endsWith("repeated-does-not-mean-bug")) {
    if (
      !report.observations.some(
        (text) =>
          /run-retry/.test(text) &&
          /repeat|read/i.test(text) &&
          /legitimate|not.{0,30}bug|unverified|uncertain|cannot.{0,30}confirm/i.test(
            text,
          ),
      )
    )
      errors.push(
        "Preserve uncertainty about repeated calls instead of labeling a bug",
      );
    if (
      !report.uncertainties.some(
        (text) =>
          /delivery/i.test(text) &&
          /unverified|unknown|not.{0,30}(recorded|reported|establish|confirm)|no.{0,20}(status|evidence)/i.test(
            text,
          ),
      )
    )
      errors.push(
        "Delivery must remain unverified without destination evidence",
      );
  }
  return {
    passed: !errors.length,
    reason:
      errors.join("; ") ||
      "Expected statuses and recovery/uncertainty cues present. Deterministic checks do not establish full semantic correctness.",
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
