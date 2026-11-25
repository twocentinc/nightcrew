import test from "node:test";
import assert from "node:assert/strict";
import { grade, type Input } from "./grade.ts";
test("supervisor grader rejects omitted incidents and leaves meaning for review", () => {
  const input: Input = {
    version: 1,
    case: {
      caseID: "missed",
      expectations: {
        criteria: [
          { criterionID: "truth", description: "Assess the cause accurately" },
        ],
      },
    },
    result: {
      answer: "# Everything is fine",
      status: "needs_review",
      messages: [
        {
          role: "tool",
          content: JSON.stringify({
            result: {
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
            },
          }),
        },
      ],
    },
  };
  assert.equal(grade(input).checks[0]?.status, "failed");
  input.result.answer =
    "### failed-run\nExecution: completed\nOutput: failed\nDelivery: failed\nAssessment: Output failed validation and was not delivered.\nNext action: Inspect the original result and correct its format.";
  const result = grade(input);
  assert.equal(result.checks[0]?.status, "passed");
  assert.equal(result.checks[1]?.status, "needs_review");
});

test("bundled eval fixture validates through the Nightcrew CLI", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtemp, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const home = await mkdtemp(path.join(tmpdir(), "nc-example-eval-"));
  try {
    const input = await readFile(
      new URL("./eval.json", import.meta.url),
      "utf8",
    );
    const response = JSON.parse(
      execFileSync(
        process.execPath,
        [
          fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
          "evals",
          "validate",
          "--home",
          home,
          "--request",
          "-",
        ],
        { input, encoding: "utf8", timeout: 10000 },
      ),
    );
    assert.equal(response.ok, true, JSON.stringify(response));
    assert.equal(response.result.valid, true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
