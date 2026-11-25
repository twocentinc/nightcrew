import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
test("Granite example uses a disabled single-turn audio agent", async () => {
  const { requestSchemas } = await import("../../dist/commands/inputs.js");
  const request = JSON.parse(
    await readFile(new URL("./agent.json", import.meta.url), "utf8"),
  );
  requestSchemas["agents create"].parse(request);
  const agent = request.agent;
  assert.equal(agent.mode, "single-turn");
  assert.equal(agent.enabled, false);
  assert.equal(agent.modelID, "granite");
});
