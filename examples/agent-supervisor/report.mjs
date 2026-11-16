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
    await report(JSON.parse(s));
  } catch {
    process.exitCode = 1;
  }
}
