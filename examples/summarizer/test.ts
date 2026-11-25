import test from "node:test";
import assert from "node:assert/strict";
import { grade, type Input } from "./grade.ts";
test("summarizer grader checks literals without treating them as semantic proof", () => {
  const input: Input = {
    version: 1,
    case: {
      caseID: "budget-not-invented",
      expectations: {
        criteria: [
          { criterionID: "pending", description: "Approval is pending" },
        ],
      },
    },
    result: {
      answer: '{"summary":"Budget $98/day"}',
      status: "needs_review",
      messages: [],
    },
  };
  assert.equal(grade(input).checks[1]?.status, "failed");
  input.result.answer =
    '{"summary":"Budget $50/day; approval remains pending"}';
  assert.equal(grade(input).checks[1]?.status, "passed");
  assert.equal(grade(input).checks[2]?.status, "needs_review");
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
