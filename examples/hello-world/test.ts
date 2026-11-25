import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("bundled examples use ordinary validated commands and remain opt-in", async () => {
  const { requestSchemas } = await import("../../dist/commands/inputs.js");
  const request = JSON.parse(
    await readFile(new URL("./agent.json", import.meta.url), "utf8"),
  );
  requestSchemas["agents create"].parse(request);
  const agent = request.agent;
  assert.equal(agent.enabled, false);
  assert.equal(agent.thinking, false);
  assert.deepEqual(agent.toolIDs, []);
  for (const name of ["turn.json", "turn-thinking.json"])
    requestSchemas["agents run"].parse(
      JSON.parse(await readFile(new URL("./" + name, import.meta.url), "utf8")),
    );
});

test("hello world grader requires the exact greeting", async () => {
  const { grade } = await import("./grade.ts");
  assert.equal(
    grade({ result: { answer: "Hello world!" } }).checks[0]?.status,
    "passed",
  );
  for (const answer of ["", "Hello world! Extra explanation.", " Hello world!"])
    assert.equal(grade({ result: { answer } }).checks[0]?.status, "failed");
});
