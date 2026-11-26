import test from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  readdir,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { grade, type Input } from "./grade.ts";
import {
  validateReport,
  renderReport,
  parseReport,
  type Report,
} from "./report.ts";
const incident = {
  runID: "failure",
  execution: "completed",
  output: "failed",
  delivery: "failed",
  assessment: "**Output** was rejected; delivery failed.",
  nextAction: "Inspect the rejected result.",
};
const valid: Report = {
  incidents: [incident],
  observations: ["Reviewed the supplied snapshot."],
  uncertainties: ["Factual correctness unverified."],
};
const response = {
  role: "tool",
  toolCallID: "overview",
  content: JSON.stringify({
    ok: true,
    result: { coverage: { priorityIssues: [incident] } },
  }),
};

test("supervisor grader checks structured statuses independently", () => {
  const input: Input = { result: valid, run: { messages: [response] } };
  assert.equal(grade(input).passed, true);
  for (const incidents of [
    [],
    [incident, incident],
    [{ ...incident, delivery: "succeeded" }],
  ])
    assert.equal(
      grade({ ...input, result: { ...valid, incidents } }).passed,
      false,
    );
});
test("eval grader distinguishes recovery and unsupported delivery claims", () => {
  const base = {
    incidents: [],
    observations: [
      "run-retry repeated read calls may be legitimate; not confirmed bugs.",
    ],
    uncertainties: ["Delivery is unverified; no destination evidence."],
  };
  const input: Input = {
    eval: { evalID: "agent-supervisor-repeated-does-not-mean-bug" },
    result: base,
    run: { messages: [] },
  };
  assert.equal(grade(input).passed, true);
  assert.equal(
    grade({
      ...input,
      result: { ...base, uncertainties: ["Delivery succeeded."] },
    }).passed,
    false,
  );
  assert.equal(
    grade({
      ...input,
      result: {
        ...base,
        observations: ["run-retry repeated reads prove a bug."],
      },
    }).passed,
    false,
  );
  const recovered: Input = {
    eval: {
      evalID: "agent-supervisor-current-failure-versus-recovered-history",
    },
    result: {
      ...valid,
      observations: [
        "recovered-child recovered through recovered-parent replacement compaction.",
      ],
    },
    run: { messages: [response] },
  };
  assert.equal(grade(recovered).passed, true);
  assert.equal(grade({ ...recovered, result: valid }).passed, false);
});
test("bundled eval definitions validate and cannot replace the agent finish schema", async () => {
  const { evalSchema } = await import("../../dist/engine/evals/format.js");
  const { agentSchema } = await import("../../dist/schemas/agent.js");
  const { z } = await import("zod");
  const agent = JSON.parse(
    await readFile(new URL("./agent.json", import.meta.url), "utf8"),
  ).agent;
  assert.equal(
    agentSchema.shape.finishSchema.safeParse(agent.finishSchema).success,
    true,
  );
  assert.equal(
    z.fromJSONSchema(agent.finishSchema).safeParse(valid).success,
    true,
  );
  assert.equal(
    z
      .fromJSONSchema(agent.finishSchema)
      .safeParse({
        ...valid,
        incidents: [{ ...incident, execution: "invented" }],
      }).success,
    false,
  );
  for (const file of await readdir(new URL(".", import.meta.url)))
    if (/^eval.*\.json$/.test(file)) {
      const definition = JSON.parse(
        await readFile(new URL(file, import.meta.url), "utf8"),
      );
      evalSchema.parse(definition);
      assert.equal(
        evalSchema.safeParse({
          ...definition,
          overrides: { finishSchema: agent.finishSchema },
        }).success,
        false,
      );
    }
});
test("coverage validates paired overview evidence without depending on Markdown", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nc-supervisor-eval-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const dir = path.join(home, "runs", "review");
  await mkdir(dir, { recursive: true });
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
    response,
  ];
  await writeFile(path.join(dir, "state.json"), JSON.stringify({ messages }));
  const check = (value: unknown) =>
    validateReport({ runID: "review", text: JSON.stringify(value) }, home);
  assert.equal((await check(valid)).valid, true);
  for (const incidents of [
    [],
    [incident, incident],
    [{ ...incident, delivery: "succeeded" }],
    [{ ...incident, runID: "invented" }],
    [{ ...incident, assessment: " " }],
  ])
    assert.equal((await check({ ...valid, incidents })).valid, false);
  assert.equal(
    (await check({ report: "### failure\nExecution: completed" })).valid,
    false,
  );
  assert.equal(
    (await validateReport({ runID: "review", text: "{" }, home)).valid,
    false,
  );
  await writeFile(
    path.join(dir, "state.json"),
    JSON.stringify({ messages: [response] }),
  );
  assert.equal((await check(valid)).valid, false);
});
test("renderer produces Markdown without asking the model for status formatting", () => {
  const text = renderReport(parseReport(JSON.stringify(valid)));
  assert.match(text, /### failure\n\nExecution: completed/);
  assert.match(text, /Assessment: \*\*Output\*\* was rejected/);
  assert.match(text, /## Uncertainties/);
  assert.match(
    renderReport({ incidents: [], observations: [], uncertainties: [] }),
    /No priority incidents/,
  );
});
