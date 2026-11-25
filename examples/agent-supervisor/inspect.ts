#!/usr/bin/env -S node --experimental-strip-types
import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  lstat,
  rename,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const homeDefault = () =>
  process.env.NIGHTCREW_HOME ?? path.join(homedir(), ".nightcrew");
async function json(file: string) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 50 * 1024 * 1024)
    throw Error("Unsafe or oversized state file");
  return JSON.parse(await readFile(file, "utf8"));
}
const terminal = (state?: any) =>
  ["completed", "failed", "timedOut", "cancelled"].includes(state);
// Public CLI outcomes are authoritative; this example only adds operational metrics.
async function call(home: string, args: string[]) {
  const { stdout } = await promisify(execFile)(
    "nightcrew",
    [...args, "--home", home],
    {
      timeout: 30000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  const result = JSON.parse(stdout);
  if (!result.ok) throw Error("Nightcrew inspection failed");
  return result.result;
}
async function outcomes(home: string) {
  const runs = new Map();
  let cursor;
  do {
    const page = await call(home, [
      "runs",
      "list",
      "--limit",
      "100",
      ...(cursor ? ["--cursor", cursor] : []),
    ]);
    for (const run of page.items) runs.set(run.runID, run);
    cursor = page.nextCursor;
  } while (cursor);
  return runs;
}
function recentProblem(r?: any, outcome?: any, since?: any) {
  if (!outcome) return false;
  const bad =
    ["failed", "timedOut"].includes(outcome.execution) ||
    ["failed", "error"].includes(outcome.output) ||
    ["failed", "unknown"].includes(outcome.delivery) ||
    (terminal(r.state) && outcome.delivery === "pending") ||
    (r.held && !terminal(r.state));
  if (!bad) return false;
  // Capability refreshes and old reviewer notes do not create new incidents.
  const relevant = (r.events ?? []).filter((e?: any) =>
    ["failed", "timedOut", "outputValidation", "hookResult", "held"].includes(
      e.type,
    ),
  );
  return (
    Math.max(
      Date.parse(r.createdAt),
      ...relevant.map((e?: any) => Date.parse(e.at)).filter(Number.isFinite),
    ) >= since
  );
}
function priorityIssues(snapshot?: any) {
  return snapshot.priorityIssues ?? [];
}
function coverage(snapshot?: any) {
  return {
    priorityIssues: priorityIssues(snapshot),
    summaryRunsRead: Object.keys(snapshot.examined).length,
    totalRuns: snapshot.items.length,
    pagesRead: Object.keys(snapshot.pagesRead ?? {})
      .map(Number)
      .sort((a, b) => a - b),
    detailedRunIDs: Object.keys(snapshot.detailsExamined ?? {}),
    detailedRunsRead: Object.keys(snapshot.detailsExamined ?? {}).length,
  };
}
async function saveSnapshot(file: string, snapshot?: any) {
  const temporary = file + "." + randomUUID() + ".tmp";
  await writeFile(temporary, JSON.stringify(snapshot), {
    flag: "wx",
    mode: 0o600,
  });
  await rename(temporary, file);
}
async function project(r: any, home: string, summary?: any) {
  if (!summary || summary.revision !== r.revision)
    throw Error(
      "Run changed during inspection; retry with a new review snapshot",
    );
  let parent;
  if (r.parentRunID && ID.test(r.parentRunID)) {
    try {
      parent = await json(path.join(home, "runs", r.parentRunID, "state.json"));
    } catch {
      /* Explicitly unverified; never infer a missing parent's state. */
    }
  }
  return metrics(r, parent, summary.outcome);
}
export function metrics(r?: any, parent?: any, outcome?: any) {
  if (!outcome) throw Error("Canonical run outcome is required");
  const groups = new Map();
  for (const m of r.messages ?? [])
    for (const c of m.toolCalls ?? []) {
      const key =
        c.name +
        ":" +
        createHash("sha256")
          .update(c.arguments ?? "")
          .digest("hex");
      const item = groups.get(key) ?? { tool: c.name, count: 0 };
      item.count++;
      groups.set(key, item);
    }
  const events = r.events ?? [];
  const repeated = [...groups.values()].filter((g) => g.count > 1);
  const toolErrors = (r.messages ?? [])
    .filter((m?: any) => m.role === "tool")
    .filter((m?: any) => {
      try {
        const v = JSON.parse(m.content);
        return v.ok === false || !!v.error;
      } catch {
        return false;
      }
    }).length;
  const qualityFlags = [];
  if (r.state === "completed") {
    if (!r.result?.trim()) qualityFlags.push("empty_output");
    try {
      const parsed = JSON.parse(r.result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        for (const [key, value] of Object.entries(parsed))
          if (Array.isArray(value) && value.length === 0)
            qualityFlags.push("empty_collection:" + key);
    } catch {
      /* Markdown and prose are valid output formats. */
    }
  }
  const parentState = r.parentRunID
    ? parent
      ? {
          runID: parent.runID,
          state: parent.state,
          revision: parent.revision,
          awaitsThisChild:
            !terminal(parent.state) &&
            parent.compaction?.childRunID === r.runID,
          relationship:
            terminal(parent.state) || parent.compaction?.childRunID !== r.runID
              ? "no_longer_required"
              : "required",
        }
      : { runID: r.parentRunID, relationship: "unverified" }
    : null;
  const delivery = {
    status: outcome.delivery,
    basis:
      "Canonical Nightcrew run outcome; external delivery is not independently verified.",
  };
  const validation = (r.validations ?? [])
    .filter((v?: any) => v.segment === (r.segment ?? 0))
    .at(-1);
  return {
    outcome,
    current: {
      execution: outcome.execution,
      activeHold: !!r.held && !terminal(r.state),
      error:
        terminal(r.state) && !["failed", "timedOut"].includes(r.state)
          ? null
          : (r.error ?? null),
      delivery,
      validation: validation
        ? { status: validation.status, at: validation.at }
        : null,
      parent: parentState,
    },
    historical: {
      hookFailures: (r.hookReceipts ?? []).filter(
        (h?: any) => h.status === "failed",
      ).length,
      validationFailures: (r.validations ?? []).filter(
        (v?: any) => v.status === "failed",
      ).length,
      retainedError: r.error ?? null,
      note: "Past evidence, not current failure status. Later successful retries or terminal parent states supersede earlier status claims.",
    },
    statusMeaning: ["completed", "failed", "timedOut", "cancelled"].includes(
      r.state,
    )
      ? r.state
      : parentState?.relationship === "no_longer_required"
        ? "stale_compactor_child"
        : r.held
          ? "held_requires_review"
          : r.state === "paused" && r.pauseReason === "compaction"
            ? "waiting_for_compactor_not_held"
            : r.state,
    quality: {
      assessment: "unreviewed",
      flags: qualityFlags,
      note: "Execution/schema success does not establish useful or supported findings. Empty collections may be honest no-findings results; inspect before judging.",
    },
    runID: r.runID,
    revision: r.revision,
    agentID: r.agent.agentID,
    parentRunID: r.parentRunID ?? null,
    state: r.state,
    held: r.held,
    pauseReason: r.pauseReason,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    activeMs: r.activeMs,
    elapsedThroughLastUpdateMs: Math.max(
      0,
      Date.parse(r.updatedAt) - Date.parse(r.createdAt),
    ),
    attempts: (r.attempts ?? []).length,
    unsuccessfulAttempts: (r.attempts ?? []).filter(
      (a?: any) => a.status !== "completed" && a.status !== "running",
    ).length,
    toolCalls: [...groups.values()].reduce((n, g) => n + g.count, 0),
    toolErrors,
    repeatedCalls: repeated.slice(0, 10),
    repeatedGroupsOmitted: Math.max(0, repeated.length - 10),
    compactions: (r.compactions ?? []).length,
    compactionRetries: events.filter((e?: any) => e.type === "compactionRetry")
      .length,
    resultCharacters: r.result?.length ?? 0,
    modelID: r.agent.modelID,
    thinking: r.agent.thinking,
    maxOutputTokens: r.agent.maxOutputTokens,
  };
}
export async function inspect(
  input?: any,
  {
    home = homeDefault(),
    runID = process.env.NIGHTCREW_RUN_ID,
    now = Date.now(),
    readOutcomes = outcomes,
    readOutcome = async (home: string, id: string) =>
      (await call(home, ["runs", "get", id])).run,
  } = {},
) {
  if (!ID.test(runID ?? "")) throw Error("Run ID required");
  if (
    !input ||
    !["overview", "page", "run"].includes(input.action) ||
    Object.keys(input).some((k) => !["action", "page", "runID"].includes(k))
  )
    throw Error("Unknown input");
  if (
    input.action === "page" &&
    (!Number.isInteger(input.page) || input.page < 0)
  )
    throw Error("Invalid page");
  if (input.action === "run" && !ID.test(input.runID ?? ""))
    throw Error("Invalid run ID");
  const directory = path.join(home, "integrations", "agent-supervisor");
  const file = path.join(directory, "snapshots", runID + ".json");
  let snapshot;
  try {
    snapshot = await json(file);
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    let previous: {
      revisions: Record<string, number>;
      baselineAt?: string;
      completedAt?: string;
      report?: string;
    } = { revisions: {} };
    try {
      previous = await json(path.join(directory, "checkpoint.json"));
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    const baselineAt =
      previous.baselineAt ?? new Date(now - 86400000).toISOString();
    const summaries = await readOutcomes(home);
    const prioritySince = Math.min(
      now - 86400000,
      Date.parse(
        previous.completedAt ?? new Date(now - 86400000).toISOString(),
      ),
    );
    const priorities = [];
    const items = [];
    let unreadableRuns = 0;
    for (const entry of await readdir(path.join(home, "runs"), {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory() || !ID.test(entry.name) || entry.name === runID)
        continue;
      try {
        const r = await json(path.join(home, "runs", entry.name, "state.json"));
        if (r.agent.agentID === "agent-supervisor") continue;
        const priority = recentProblem(
          r,
          summaries.get(r.runID)?.outcome,
          prioritySince,
        );
        if (!priority && previous.revisions?.[r.runID] === r.revision) continue;
        if (
          !priority &&
          Date.parse(r.updatedAt) < Date.parse(baselineAt) &&
          !r.held &&
          !["failed", "timedOut"].includes(r.state)
        )
          continue;
        const item = await project(r, home, summaries.get(r.runID));
        if (priority)
          priorities.push({
            runID: r.runID,
            agentID: r.agent.agentID,
            execution: item.outcome.execution,
            output: item.outcome.output,
            delivery: item.outcome.delivery,
            reasons: item.outcome.reasons
              .slice(0, 3)
              .map((x?: any) => x.slice(0, 300)),
            parent: item.current.parent,
          });
        items.push(item);
      } catch {
        unreadableRuns++;
      }
    }
    items.sort(
      (a, b) =>
        Number(
          !!b.current.error ||
            b.current.activeHold ||
            ["failed", "unknown"].includes(b.current.delivery.status),
        ) -
          Number(
            !!a.current.error ||
              a.current.activeHold ||
              ["failed", "unknown"].includes(a.current.delivery.status),
          ) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.runID.localeCompare(b.runID),
    );
    snapshot = {
      baselineAt,
      prioritySince: new Date(prioritySince).toISOString(),
      priorityIssues: priorities,
      capturedAt: new Date(now).toISOString(),
      previousReport: previous.report ?? null,
      firstReview: !previous.completedAt,
      unreadableRuns,
      omittedRuns: Math.max(0, items.length - 1000),
      items: items.slice(0, 1000),
      examined: {},
      pagesRead: {},
      detailsExamined: {},
    };
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
  }
  const totalPages = Math.ceil(snapshot.items.length / 5);
  if (input.action === "overview")
    return {
      coverage: coverage(snapshot),
      capturedAt: snapshot.capturedAt,
      previousReport: snapshot.previousReport,
      firstReview: snapshot.firstReview,
      totalRuns: snapshot.items.length,
      totalPages,
      unreadableRuns: snapshot.unreadableRuns,
      omittedRuns: snapshot.omittedRuns,
      scope:
        "Changed revisions since last successful report; first review covers last 24h plus older held/failed runs. Metrics only, not a factual audit of outputs.",
      nextPage: totalPages ? 0 : null,
    };
  if (input.action === "page") {
    if (input.page >= totalPages)
      throw Error("No such page; finish the report if nextPage was null");
    const items = snapshot.items.slice(input.page * 5, input.page * 5 + 5);
    for (const item of items) snapshot.examined[item.runID] = item.revision;
    snapshot.pagesRead ??= {};
    snapshot.pagesRead[input.page] = true;
    await saveSnapshot(file, snapshot);
    return {
      coverage: coverage(snapshot),
      page: input.page,
      items,
      nextPage: input.page + 1 < totalPages ? input.page + 1 : null,
      complete: input.page + 1 >= totalPages,
    };
  }
  if (!snapshot.items.some((r?: any) => r.runID === input.runID))
    throw Error("Run is outside this review snapshot");
  const r = await json(path.join(home, "runs", input.runID, "state.json"));
  const projected = await project(r, home, await readOutcome(home, r.runID));
  snapshot.detailsExamined ??= {};
  snapshot.detailsExamined[r.runID] = r.revision;
  await saveSnapshot(file, snapshot);
  return {
    ...projected,
    coverage: coverage(snapshot),
    snapshotRevision: snapshot.items.find((x?: any) => x.runID === input.runID)
      .revision,
    reportExcerpt:
      typeof r.result === "string" ? r.result.slice(0, 4000) : null,
    reportTruncated: (r.result?.length ?? 0) > 4000,
    historicalFailureEvents: (r.events ?? [])
      .filter((e?: any) =>
        ["compactionRetry", "failed", "timedOut", "recovery"].includes(e.type),
      )
      .slice(-6),
    caveat:
      "State may have changed since snapshot. Tool arguments, raw source data, thinking and prompts are intentionally omitted. Repeated calls may be legitimate; investigate before acting.",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 16000) throw Error("Input too large");
    }
    console.log(
      JSON.stringify({ ok: true, result: await inspect(JSON.parse(input)) }),
    );
  } catch (e: unknown) {
    console.log(
      JSON.stringify({
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      }),
    );
  }
}
