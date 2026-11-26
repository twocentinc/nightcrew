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

test("supervisor validation can use a recorded overview without tool filesystem side effects", async (t) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const { validateReport } = await import("./report.ts");
  const home = await mkdtemp(path.join(tmpdir(), "nc-supervisor-eval-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "runs", "review");
  await mkdir(dir, { recursive: true });
  const message = {
    role: "tool",
    toolCallID: "overview",
    content: JSON.stringify({
      ok: true,
      result: {
        coverage: {
          priorityIssues: [
            {
              runID: "failure",
              execution: "completed",
              output: "failed",
              delivery: "failed",
            },
          ],
        },
      },
    }),
  };
  const messages = [
    {
      role: "assistant",
      toolCalls: [
        {
          callID: "overview",
          name: "nightcrew_inspect",
          arguments: '{"action":"overview"}',
        },
      ],
    },
    message,
  ];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ messages }));
  assert.equal(
    (
      await validateReport(
        { runID: "review", text: "Everything is fine" },
        home,
      )
    ).valid,
    false,
  );
  assert.equal(
    (
      await validateReport(
        {
          runID: "review",
          text: "### failure\nExecution: completed\nOutput: failed\nDelivery: failed\nAssessment: The accepted output failed its validation checks.\nNext action: Inspect the failed validation.",
        },
        home,
      )
    ).valid,
    true,
  );
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({ messages: [message] }),
  );
  assert.equal(
    (
      await validateReport(
        { runID: "review", text: "Everything is fine" },
        home,
      )
    ).valid,
    false,
  );
});
