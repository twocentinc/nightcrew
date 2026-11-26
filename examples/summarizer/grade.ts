import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type Input = { eval: { evalID: string }; result: unknown };
export function grade(input: Input) {
  const result =
    typeof input.result === "string" ? JSON.parse(input.result) : input.result;
  const summary = (result as { summary?: string })?.summary ?? "";
  const literal = input.eval.evalID.endsWith("budget-not-invented")
    ? "$50/day"
    : "2026-11-11T05:42:35.293Z";
  return {
    passed: summary.includes(literal),
    reason:
      "Require literal preservation of " +
      literal +
      ". This check does not establish semantic correctness.",
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
