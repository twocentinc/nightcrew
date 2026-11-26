import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { grade, type Input } from "./grade.ts";
test("summarizer grader preserves the literal budget", () => {
  const input: Input = {
    eval: { evalID: "summarizer-budget-not-invented" },
    result: { summary: "Budget $98/day" },
  };
  assert.equal(grade(input).passed, false);
  input.result = { summary: "Budget $50/day; approval pending" };
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
