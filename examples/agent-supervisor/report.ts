#!/usr/bin/env -S node --experimental-strip-types
import {
  mkdir,
  writeFile,
  readFile,
  link,
  unlink,
  rename,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
export type Incident = {
  runID: string;
  execution: string;
  output: string;
  delivery: string;
  assessment: string;
  nextAction: string;
};
export type Report = {
  incidents: Incident[];
  observations: string[];
  uncertainties: string[];
};
export function parseReport(text: string): Report {
  const value = JSON.parse(text);
  const strings = (items: unknown): items is string[] =>
    Array.isArray(items) &&
    items.every((item) => typeof item === "string" && item.trim());
  if (
    !value ||
    !Array.isArray(value.incidents) ||
    !strings(value.observations) ||
    !strings(value.uncertainties) ||
    !value.incidents.every(
      (item: unknown) =>
        item &&
        typeof item === "object" &&
        [
          "runID",
          "execution",
          "output",
          "delivery",
          "assessment",
          "nextAction",
        ].every(
          (key) =>
            typeof (item as Record<string, unknown>)[key] === "string" &&
            String((item as Record<string, unknown>)[key]).trim(),
        ),
    )
  )
    throw Error(
      "Expected structured incidents, observations and uncertainties",
    );
  return value as Report;
}
export function renderReport(report: Report): string {
  const lines = [
    "# Nightcrew operational review",
    "",
    "## Current incidents",
    "",
  ];
  if (!report.incidents.length)
    lines.push("No priority incidents reported.", "");
  for (const item of report.incidents)
    lines.push(
      `### ${item.runID}`,
      "",
      `Execution: ${item.execution}`,
      `Output: ${item.output}`,
      `Delivery: ${item.delivery}`,
      "",
      `Assessment: ${item.assessment}`,
      "",
      `Next action: ${item.nextAction}`,
      "",
    );
  for (const [heading, items] of [
    ["Observations", report.observations],
    ["Uncertainties", report.uncertainties],
  ] as const)
    lines.push(
      `## ${heading}`,
      "",
      ...(items.length
        ? items.map((item) => "- " + item.replace(/\n/g, "\n  "))
        : ["None reported."]),
      "",
    );
  return lines.join("\n").trimEnd();
}
export async function validateReport(
  input?: any,
  home = process.env.NIGHTCREW_HOME ?? path.join(homedir(), ".nightcrew"),
) {
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input?.runID ?? "") ||
    typeof input.text !== "string"
  )
    return { valid: false, reason: "Invalid validation request" };
  let snapshot;
  try {
    snapshot = JSON.parse(
      await readFile(
        path.join(
          home,
          "integrations",
          "agent-supervisor",
          "snapshots",
          input.runID + ".json",
        ),
        "utf8",
      ),
    );
  } catch {
    // Tool overrides return data without writing the inspector's snapshot file.
    // A recorded successful overview carries the same validation evidence.
    try {
      const run = JSON.parse(
        await readFile(
          path.join(home, "runs", input.runID, "state.json"),
          "utf8",
        ),
      );
      const overviewCalls = new Set<string>();
      for (const message of run.messages ?? []) {
        if (message.role === "assistant")
          for (const call of message.toolCalls ?? []) {
            if (call.name !== "nightcrew_inspect") continue;
            try {
              if (JSON.parse(call.arguments).action === "overview")
                overviewCalls.add(call.callID);
            } catch {}
          }
        if (message.role === "tool" && overviewCalls.has(message.toolCallID)) {
          try {
            const response = JSON.parse(message.content);
            if (
              response.ok === true &&
              Array.isArray(response.result?.coverage?.priorityIssues)
            )
              snapshot = {
                priorityIssues: response.result.coverage.priorityIssues,
              };
          } catch {}
        }
      }
    } catch {}
    if (!snapshot)
      return {
        valid: false,
        reason: "Read the supervisor overview before completing the report.",
      };
  }
  if (!Array.isArray(snapshot.priorityIssues))
    return {
      valid: false,
      reason: "Review snapshot lacks priority coverage; start a fresh review.",
    };
  let report: Report;
  try {
    report = parseReport(input.text);
  } catch {
    return {
      valid: false,
      reason:
        "Finish must contain structured incidents, observations and uncertainties.",
    };
  }
  const expected = new Map<string, Incident>(
    snapshot.priorityIssues.map((issue: Incident) => [issue.runID, issue]),
  );
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const incident of report.incidents) {
    const issue = expected.get(incident.runID);
    if (seen.has(incident.runID))
      errors.push(`Duplicate incident: ${incident.runID}`);
    seen.add(incident.runID);
    if (!issue) errors.push(`Not a priority incident: ${incident.runID}`);
    else
      for (const field of ["execution", "output", "delivery"] as const)
        if (incident[field] !== issue[field])
          errors.push(`${incident.runID}.${field}: expected ${issue[field]}`);
  }
  for (const id of expected.keys())
    if (!seen.has(id)) errors.push(`Missing priority incident: ${id}`);
  return errors.length
    ? { valid: false, reason: errors.join("; ").slice(0, 2000) }
    : {
        valid: true,
        reason:
          "Priority coverage and supplied statuses match; factual quality is not established by this check.",
      };
}

export async function report(
  event?: any,
  home = process.env.NIGHTCREW_HOME ?? path.join(homedir(), ".nightcrew"),
  agentIDs = ["agent-supervisor"],
) {
  if (event?.event !== "run.completed" || !agentIDs.includes(event.agentID))
    return { skipped: true };
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(event.agentID) ||
    event.version !== 1 ||
    event.state !== "completed" ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(event.runID) ||
    typeof event.turnID !== "string" ||
    !/^[0-9a-f-]{36}$/i.test(event.turnID) ||
    typeof event.result !== "string" ||
    !event.result.trim() ||
    event.result.length > 1048576
  )
    throw Error("Invalid report event");
  if (event.agentID === "agent-supervisor") {
    const verdict = await validateReport(
      { runID: event.runID, text: event.result },
      home,
    );
    if (!verdict.valid) throw Error(verdict.reason);
  }
  const dir = path.join(home, "integrations", event.agentID);
  await mkdir(path.join(dir, "reports"), { recursive: true, mode: 0o700 });
  const file = path.join(
    dir,
    "reports",
    event.runID + (event.turnID ? "-turn-" + event.turnID : "") + ".md",
  );
  const text =
    (event.agentID === "agent-supervisor"
      ? renderReport(parseReport(event.result))
      : event.result) + "\n";
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, text, { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(tmp, file);
    } catch (e: unknown) {
      if (
        (e as NodeJS.ErrnoException).code !== "EEXIST" ||
        (await readFile(file, "utf8")) !== text
      )
        throw e;
    }
  } finally {
    await unlink(tmp);
  }
  if (event.agentID === "agent-supervisor") {
    let snapshot;
    try {
      snapshot = JSON.parse(
        await readFile(
          path.join(dir, "snapshots", event.runID + ".json"),
          "utf8",
        ),
      );
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    if (snapshot) {
      const checkpoint = path.join(dir, "checkpoint.json");
      let old: {
        revisions: Record<string, number>;
        capturedAt?: string;
        baselineAt?: string;
        completedAt?: string;
        report?: string;
      } = { revisions: {} };
      try {
        old = JSON.parse(await readFile(checkpoint, "utf8"));
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      const revisions = { ...old.revisions };
      for (const [id, revision] of Object.entries(
        snapshot.examined as Record<string, number>,
      ))
        revisions[id] = Math.max(revisions[id] ?? 0, revision);
      const newer = !old.capturedAt || snapshot.capturedAt >= old.capturedAt;
      const next = {
        revisions,
        baselineAt: old.baselineAt ?? snapshot.baselineAt,
        capturedAt: newer ? snapshot.capturedAt : old.capturedAt,
        completedAt: newer ? new Date().toISOString() : old.completedAt,
        report: newer ? file : old.report,
        coverage:
          "Only run summaries actually returned by page tool; not a full transcript audit.",
      };
      const temp = checkpoint + "." + randomUUID() + ".tmp";
      await writeFile(temp, JSON.stringify(next), { flag: "wx", mode: 0o600 });
      await rename(temp, checkpoint);
    }
  }
  return { file };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href
) {
  try {
    let s = "";
    for await (const c of process.stdin) {
      s += c;
      if (s.length > 2 * 1024 * 1024) throw Error("Input too large");
    }
    if (process.argv[2] === "--validate")
      console.log(JSON.stringify(await validateReport(JSON.parse(s))));
    else await report(JSON.parse(s));
  } catch {
    process.exitCode = 1;
  }
}
