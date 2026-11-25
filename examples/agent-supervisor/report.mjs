#!/usr/bin/env node
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
import { pathToFileURL } from "node:url";
export async function validateReport(
  input,
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
  // Headings inside code fences are not report sections.
  const text = input.text.replace(/```[\s\S]*?```/g, "");
  const missing = [];
  for (const issue of snapshot.priorityIssues) {
    const parts = text.split(/^###\s+(.+?)\s*$/m);
    let body;
    for (let i = 1; i < parts.length; i += 2)
      if (parts[i].trim() === issue.runID)
        body = parts[i + 1].split(/^#{1,3}\s/m)[0];
    const fields = {
      Execution: issue.execution,
      Output: issue.output,
      Delivery: issue.delivery,
    };
    if (
      !body ||
      Object.entries(fields).some(
        ([key, value]) =>
          !body
            .split(/\r?\n/)
            .some((line) => line.trim() === `${key}: ${value}`),
      ) ||
      !/^Assessment: .{20,}$/m.test(body) ||
      !/^Next action: .{10,}$/m.test(body)
    )
      missing.push(issue);
  }
  return missing.length
    ? {
        valid: false,
        reason:
          "Address each priority incident in its own Markdown section: ### RUN_ID, then exact lines Execution: VALUE, Output: VALUE, Delivery: VALUE, Assessment: explanation, Next action: recommendation. Missing/incomplete: " +
          JSON.stringify(missing).slice(0, 1500),
      }
    : {
        valid: true,
        reason:
          "All required priority sections are present; factual quality is not established by this check.",
      };
}

export async function report(
  event,
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
    !Number.isInteger(event.segment) ||
    event.segment < 0 ||
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
    event.runID + (event.segment ? "-segment-" + event.segment : "") + ".md",
  );
  const text = event.result + "\n";
  const tmp = file + "." + randomUUID() + ".tmp";
  await writeFile(tmp, text, { flag: "wx", mode: 0o600 });
  try {
    try {
      await link(tmp, file);
    } catch (e) {
      if (e.code !== "EEXIST" || (await readFile(file, "utf8")) !== text)
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
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (snapshot) {
      const checkpoint = path.join(dir, "checkpoint.json");
      let old = { revisions: {} };
      try {
        old = JSON.parse(await readFile(checkpoint, "utf8"));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const revisions = { ...old.revisions };
      for (const [id, revision] of Object.entries(snapshot.examined))
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
  import.meta.url === pathToFileURL(process.argv[1]).href
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
