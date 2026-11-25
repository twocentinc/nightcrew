import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function grade(input: {result: {answer: string}}) {
  return {checks: [{
    checkID: "exact-greeting",
    status: input.result.answer === "Hello world!" ? "passed" : "failed",
    reason: "The answer must be exactly Hello world! with no extra text.",
  }]};
}
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
    if (Buffer.byteLength(input) > 16 * 1024 * 1024) throw Error("Grader input limit");
  }
  console.log(JSON.stringify(grade(JSON.parse(input))));
}
