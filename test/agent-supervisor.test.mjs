import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  mkdir,
  writeFile,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  inspect,
  metrics as projectMetrics,
} from "../examples/agent-supervisor/inspect.mjs";
import { report } from "../examples/agent-supervisor/report.mjs";
import { runOutcome, reviewFingerprint } from "../dist/supervision.js";
const canonical = (r) =>
  runOutcome({
    segment: 0,
    hookReceipts: [],
    validations: [],
    reviews: [],
    ...r,
  });
const metrics = (r, parent) => projectMetrics(r, parent, canonical(r));
const readOutcome = async (home, id) => {
  const r = JSON.parse(
    await readFile(path.join(home, "runs", id, "state.json")),
  );
  return { ...r, outcome: canonical(r) };
};
const readOutcomes = async (home) =>
  new Map(
    await Promise.all(
      (await readdir(path.join(home, "runs"))).map(async (id) => [
        id,
        await readOutcome(home, id),
      ]),
    ),
  );
const now = Date.parse("2026-11-12T00:00:00Z");
const run = (id, overrides = {}) => ({
  runID: id,
  revision: 1,
  agent: { agentID: "worker", modelID: "local", thinking: false },
  state: "completed",
  held: false,
  createdAt: new Date(now - 20000).toISOString(),
  updatedAt: new Date(now - 10000).toISOString(),
  activeMs: 4000,
  segment: 0,
  hookReceipts: [],
  validations: [],
  reviews: [],
  messages: [],
  events: [],
  result: "ok",
  ...overrides,
});
async function fixture(t) {
  const home = await mkdtemp(path.join(tmpdir(), "supervisor-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, "runs"));
  return {
    home,
    put: async (r) => {
      const dir = path.join(home, "runs", r.runID);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "state.json"), JSON.stringify(r));
    },
  };
}
test("supervisor freezes metrics, excludes itself and old healthy work, checkpoints only read pages", async (t) => {
  const { home, put } = await fixture(t);
  for (let i = 0; i < 7; i++) await put(run("run-" + i));
  await put(run("self", { agent: { agentID: "agent-supervisor" } }));
  await put(run("old", { updatedAt: "2025-01-01T00:00:00Z" }));
  await put(
    run("old-failed", {
      state: "failed",
      error: { code: "failure" },
      updatedAt: "2025-01-01T00:00:00Z",
    }),
  );
  await writeFile(path.join(home, "config.json"), "secret sentinel");
  const opts = { home, runID: "review", now, readOutcome, readOutcomes };
  const overview = await inspect({ action: "overview" }, opts);
  assert.equal(overview.totalRuns, 8);
  assert.equal(overview.totalPages, 2);
  const page = await inspect({ action: "page", page: 0 }, opts);
  assert.equal(page.items[0].runID, "old-failed");
  assert.equal(page.items.length, 5);
  await assert.rejects(inspect({ action: "run", runID: "../config" }, opts));
  await assert.rejects(inspect({ action: "run", runID: "old" }, opts));
  const event = {
    version: 1,
    event: "run.completed",
    state: "completed",
    agentID: "agent-supervisor",
    runID: "review",
    segment: 0,
    result: "# Findings\nReview complete for first page.",
  };
  await report(event, home);
  await report(event, home);
  const checkpoint = JSON.parse(
    await readFile(
      path.join(home, "integrations/agent-supervisor/checkpoint.json"),
    ),
  );
  assert.equal(Object.keys(checkpoint.revisions).length, 5);
  assert.equal(
    (await inspect({ action: "overview" }, { ...opts, runID: "next" }))
      .totalRuns,
    3,
  );
  await put(run("run-0", { revision: 2 }));
  assert.equal(
    (await inspect({ action: "overview" }, { ...opts, runID: "third" }))
      .totalRuns,
    4,
  );
  assert.equal((await inspect({ action: "overview" }, opts)).totalRuns, 8);
  await assert.rejects(report({ ...event, result: "different" }, home));
  assert.equal(
    await readFile(path.join(home, "config.json"), "utf8"),
    "secret sentinel",
  );
});
test("metrics distinguish retries, repeated calls and errors without revealing tool arguments", () => {
  const r = run("run", {
    messages: [
      {
        toolCalls: [
          { name: "read", arguments: "private-value" },
          { name: "read", arguments: "private-value" },
        ],
      },
      { role: "tool", content: '{"ok":false,"error":{"message":"failed"}}' },
    ],
    events: [{ type: "compactionRetry" }],
  });
  const m = metrics(r);
  assert.equal(m.repeatedCalls[0].count, 2);
  assert.equal(m.toolErrors, 1);
  assert.equal(m.compactionRetries, 1);
  assert.ok(!JSON.stringify(m).includes("private-value"));
});
test("Markdown hook scopes agents, preserves exact result and rejects traversal", async (t) => {
  const { home } = await fixture(t);
  assert.deepEqual(
    await report({ event: "run.completed", agentID: "other" }, home),
    { skipped: true },
  );
  const e = {
    version: 1,
    event: "run.completed",
    state: "completed",
    agentID: "loose-threads",
    runID: "report",
    segment: 0,
    result: "# Open loops\nNone observed.",
  };
  const out = await report(e, home, ["loose-threads"]);
  assert.equal(await readFile(out.file, "utf8"), e.result + "\n");
  await report(e, home, ["loose-threads"]);
  await assert.rejects(
    report({ ...e, runID: "../escape" }, home, ["loose-threads"]),
  );
});

test("supervisor separates compaction waiting and empty useful output from execution success", () => {
  const waiting = metrics(
    run("wait", { state: "paused", pauseReason: "compaction", held: false }),
  );
  assert.equal(waiting.statusMeaning, "waiting_for_compactor_not_held");
  assert.equal(
    metrics(run("held", { state: "paused", held: true })).statusMeaning,
    "held_requires_review",
  );
  const empty = metrics(run("empty", { result: '{"insights":[]}' }));
  assert.deepEqual(empty.quality.flags, ["empty_collection:insights"]);
  assert.equal(empty.quality.assessment, "unreviewed");
  assert.equal(empty.state, "completed");
});

test("supervisor exposes requested quality reviews without equating them with failed execution", () => {
  const result = metrics(
    run("reviewed", {
      segment: 0,
      reviews: [
        {
          segment: 0,
          status: "open",
          note: "Unsupported recommendation",
          at: "2026-11-13T00:00:00Z",
        },
      ],
    }),
  );
  assert.equal(result.state, "completed");
  assert.deepEqual(result.quality.flags, []); // A stale review is not current canonical status.
  assert.equal(result.lastReview.note, "Unsupported recommendation");
});

test("terminal supervisor records are not reported as active holds", () => {
  for (const state of ["completed", "cancelled", "failed", "timedOut"])
    assert.equal(
      metrics(run("terminal", { state, held: true })).statusMeaning,
      state,
    );
});

test("recovered delivery and validation supersede historical failures and dated reviews", () => {
  const r = run("recovered", {
    segment: 1,
    deliveryExpected: true,
    events: [
      { sequence: 1, segment: 0 },
      { sequence: 2, segment: 1 },
      { sequence: 3, segment: 1 },
      { sequence: 4, segment: 1 },
    ],
    hookReceipts: [
      {
        eventSequence: 1,
        executablePath: "/private/old",
        purpose: "delivery",
        status: "failed",
        retryOf: null,
      },
      {
        eventSequence: 2,
        executablePath: "/private/send",
        purpose: "delivery",
        status: "failed",
        retryOf: null,
      },
      {
        eventSequence: 3,
        executablePath: "/private/send",
        purpose: "delivery",
        status: "failed",
        retryOf: 1,
      },
      {
        eventSequence: 4,
        executablePath: "/private/send",
        purpose: "delivery",
        status: "succeeded",
        retryOf: 2,
      },
    ],
    validations: [
      { segment: 1, status: "failed" },
      { segment: 1, status: "passed" },
    ],
    error: { code: "old_failure" },
    reviews: [
      { segment: 1, status: "open", note: "Delivery failed before retry" },
    ],
  });
  const m = metrics(r);
  assert.equal(m.current.delivery.status, "succeeded");
  assert.deepEqual(m.outcome, canonical(r));
  assert.equal(m.historical.hookFailures, 3);
  assert.equal(m.current.validation.status, "passed");
  assert.equal(m.historical.validationFailures, 1);
  assert.equal(m.current.error, null);
  assert.equal(m.lastReview.evidenceKind, "point_in_time_reviewer_note");
  assert.ok(!JSON.stringify(m).includes("/private/send"));
  r.hookReceipts.at(-1).status = "unknown";
  assert.equal(metrics(r).current.delivery.status, "unknown");
  r.hookReceipts.at(-1).status = "pending";
  assert.equal(metrics(r).current.delivery.status, "pending");
});

test("parent evidence distinguishes stale children from required and unverified children", async (t) => {
  const { home, put } = await fixture(t);
  const child = run("child", {
    state: "paused",
    held: true,
    parentRunID: "parent",
  });
  await put(child);
  await put(run("parent", { state: "completed", compaction: null }));
  const opts = { home, runID: "review", now, readOutcome, readOutcomes };
  const detail = await inspect({ action: "run", runID: "child" }, opts);
  assert.equal(detail.statusMeaning, "stale_compactor_child");
  assert.equal(detail.current.parent.awaitsThisChild, false);
  assert.equal(
    metrics(
      child,
      run("parent", { state: "paused", compaction: { childRunID: "child" } }),
    ).current.parent.relationship,
    "required",
  );
  assert.equal(metrics(child).current.parent.relationship, "unverified");
});

test("coverage counts distinct pages and detailed runs, and detail refreshes snapshot status", async (t) => {
  const { home, put } = await fixture(t);
  await put(run("one", { state: "failed", error: { code: "old" } }));
  await put(run("two"));
  const opts = { home, runID: "review", now, readOutcome, readOutcomes };
  await inspect({ action: "page", page: 0 }, opts);
  await inspect({ action: "page", page: 0 }, opts);
  await put(run("one", { revision: 2, state: "completed" }));
  await inspect({ action: "run", runID: "one" }, opts);
  const detail = await inspect({ action: "run", runID: "one" }, opts);
  assert.equal(detail.current.execution, "completed");
  assert.equal(detail.snapshotRevision, 1);
  assert.equal(detail.revision, 2);
  assert.deepEqual(detail.coverage, {
    summaryRunsRead: 2,
    totalRuns: 2,
    pagesRead: [0],
    detailedRunIDs: ["one"],
    detailedRunsRead: 1,
  });
});
