#!/usr/bin/env node
import {
  readFile,
  readdir,
  mkdir,
  writeFile,
  lstat,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
const ID = /^[a-zA-Z0-9_-]{1,128}$/;
const homeDefault = () =>
  process.env.NIGHTCREW_HOME ?? path.join(homedir(), ".nightcrew");
async function json(file) {
  const st = await lstat(file);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 50 * 1024 * 1024)
    throw Error("Unsafe or oversized state file");
  return JSON.parse(await readFile(file, "utf8"));
}
export function metrics(r) {
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
    .filter((m) => m.role === "tool")
    .filter((m) => {
      try {
        const v = JSON.parse(m.content);
        return v.ok === false || !!v.error;
      } catch {
        return false;
      }
    }).length;
  const qualityFlags = [];
  const lastReview = (r.reviews ?? []).filter(review => review.segment === (r.segment ?? 0)).at(-1);
  if (lastReview && ["open", "acknowledged"].includes(lastReview.status)) qualityFlags.push("review_requested");
  if (r.state === "completed") {
    if (!r.result?.trim()) qualityFlags.push("empty_output");
    try {
      const parsed = JSON.parse(r.result);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
        for (const [key, value] of Object.entries(parsed))
          if (Array.isArray(value) && value.length === 0) qualityFlags.push("empty_collection:" + key);
    } catch { /* Markdown and prose are valid output formats. */ }
  }
  return {
    lastReview: lastReview ? { status: lastReview.status, note: lastReview.note, at: lastReview.at } : null,
    statusMeaning: ["completed", "failed", "timedOut", "cancelled"].includes(r.state) ? r.state : r.held ? "held_requires_review" : r.state === "paused" && r.pauseReason === "compaction" ? "waiting_for_compactor_not_held" : r.state,
    quality: { assessment: "unreviewed", flags: qualityFlags, note: "Execution/schema success does not establish useful or supported findings. Empty collections may be honest no-findings results; inspect before judging." },
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
      (a) => a.status !== "completed" && a.status !== "running",
    ).length,
    toolCalls: [...groups.values()].reduce((n, g) => n + g.count, 0),
    toolErrors,
    repeatedCalls: repeated.slice(0, 10),
    repeatedGroupsOmitted: Math.max(0, repeated.length - 10),
    compactions: (r.compactions ?? []).length,
    compactionRetries: events.filter((e) => e.type === "compactionRetry")
      .length,
    hookFailures: (r.hookReceipts ?? []).filter((h) => h.status === "failed")
      .length,
    validationFailures: (r.validations ?? []).filter(
      (v) => v.status === "failed",
    ).length,
    errorCode: r.error?.code ?? null,
    resultCharacters: r.result?.length ?? 0,
    modelID: r.agent.modelID,
    thinking: r.agent.thinking,
    maxOutputTokens: r.agent.maxOutputTokens,
  };
}
export async function inspect(
  input,
  {
    home = homeDefault(),
    runID = process.env.NIGHTCREW_RUN_ID,
    now = Date.now(),
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
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    let previous = { revisions: {} };
    try {
      previous = await json(path.join(directory, "checkpoint.json"));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const baselineAt =
      previous.baselineAt ?? new Date(now - 86400000).toISOString();
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
        if (previous.revisions?.[r.runID] === r.revision) continue;
        if (
          Date.parse(r.updatedAt) < Date.parse(baselineAt) &&
          !r.held &&
          !["failed", "timedOut"].includes(r.state)
        )
          continue;
        items.push(metrics(r));
      } catch {
        unreadableRuns++;
      }
    }
    items.sort(
      (a, b) =>
        Number(!!b.errorCode || b.held) - Number(!!a.errorCode || a.held) ||
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.runID.localeCompare(b.runID),
    );
    snapshot = {
      baselineAt,
      capturedAt: new Date(now).toISOString(),
      previousReport: previous.report ?? null,
      firstReview: !previous.completedAt,
      unreadableRuns,
      omittedRuns: Math.max(0, items.length - 1000),
      items: items.slice(0, 1000),
      examined: {},
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
    const temporary = file + "." + randomUUID() + ".tmp";
    await writeFile(temporary, JSON.stringify(snapshot), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
    return {
      page: input.page,
      items,
      nextPage: input.page + 1 < totalPages ? input.page + 1 : null,
      complete: input.page + 1 >= totalPages,
    };
  }
  if (!snapshot.items.some((r) => r.runID === input.runID))
    throw Error("Run is outside this review snapshot");
  const r = await json(path.join(home, "runs", input.runID, "state.json"));
  return {
    ...metrics(r),
    snapshotRevision: snapshot.items.find((x) => x.runID === input.runID)
      .revision,
    error: r.error,
    reviews: (r.reviews ?? []).slice(-2).map(({ status, note, at, segment }) => ({ status, note, at, segment })),
    reportExcerpt: typeof r.result === "string" ? r.result.slice(0, 4000) : null,
    reportTruncated: (r.result?.length ?? 0) > 4000,
    failures: (r.events ?? [])
      .filter((e) =>
        ["compactionRetry", "failed", "timedOut", "recovery"].includes(e.type),
      )
      .slice(-6),
    caveat:
      "State may have changed since snapshot. Tool arguments, raw source data, thinking and prompts are intentionally omitted. Repeated calls may be legitimate; investigate before acting.",
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
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
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: { message: e.message } }));
  }
}
