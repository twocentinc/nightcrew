import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { grade, type Input } from "./grade.ts";
test("supervisor grader requires the incident status and assessment", () => {
  const input: Input = {
    result: "# Everything is fine",
    run: {
      messages: [
        {
          role: "tool",
          content: JSON.stringify({
            coverage: {
              priorityIssues: [
                {
                  runID: "failed-run",
                  execution: "completed",
                  output: "failed",
                  delivery: "failed",
                },
              ],
            },
          }),
        },
      ],
    },
  };
  assert.equal(grade(input).passed, false);
  input.result =
    "### failed-run\nExecution: completed\nOutput: failed\nDelivery: failed\nAssessment: Output failed validation and was not delivered.\nNext action: Inspect the original result and correct its format.";
  assert.equal(grade(input).passed, true);
});
test("bundled eval definitions validate against the shared contract", async () => {
  const { evalSchema } = await import("../../dist/engine/evals/format.js");
  for (const file of await readdir(new URL(".", import.meta.url)))
    if (/^eval.*\.json$/.test(file))
      evalSchema.parse(
        JSON.parse(await readFile(new URL(file, import.meta.url), "utf8")),
      );
});
