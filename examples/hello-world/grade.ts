import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export function grade(input: { result: unknown }) {
  return {
    passed: input.result === "Hello world!",
    reason: "Require exactly Hello world! without extra text.",
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
