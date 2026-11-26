import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeStoredTool } from "../engine/capabilities/registry.js";
import { validateCompactionState } from "../engine/compaction/format.js";
import { checkpoint } from "../engine/execution/process.js";
import { invalidInput, NightcrewError } from "../engine/protocol.js";
import { type Service } from "../engine/service.js";
import { agentSchema, skillSchema } from "../schemas/agent.js";
import {
  encodeRun,
  decodeRun,
  runProjectionSchema,
  transcriptEntrySchema,
  type Run,
} from "../schemas/run.js";
import { canonical } from "../utils/json.js";

const filenames = [
  "run.json",
  "transcript.json",
  "configuration.json",
  "result.json",
] as const;
const digest = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const encode = (value: unknown) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
const checksumSchema = z.strictObject({
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024 * 1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const manifestSchema = z.strictObject({
  version: z.literal(1),
  runID: runProjectionSchema.shape.runID,
  revision: runProjectionSchema.shape.revision,
  lastEventSequence: z.number().int().nonnegative(),
  files: z
    .array(checksumSchema.extend({ path: z.enum(filenames) }))
    .length(filenames.length),
  attachments: z
    .array(
      checksumSchema.extend({
        messageID: z.uuid(),
        index: z.number().int().nonnegative(),
      }),
    )
    .max(160000),
});
function attachments(run: Run) {
  return run.messages.flatMap((message) =>
    message.attachments.map((attachment, index) => {
      const data = Buffer.from(attachment.dataBase64, "base64");
      if (data.toString("base64") !== attachment.dataBase64)
        throw Error("Invalid attachment encoding");
      return {
        messageID: message.messageID,
        index,
        bytes: data.length,
        sha256: digest(data),
      };
    }),
  );
}
function validate(run: Run, runID: string) {
  if (run.runID !== runID) throw Error("Run identity mismatch");
  const messages = new Map(
    [
      ...run.messages,
      ...run.pendingInputs.map((p) => ({
        ...p.message,
        role: "user" as const,
        toolCalls: [],
        toolCallID: null,
      })),
    ].map((m) => [m.messageID, m]),
  );
  if (messages.size !== run.messages.length + run.pendingInputs.length)
    throw Error("Duplicate message UUID");
  const calls = new Set<string>(),
    results = new Set<string>();
  for (const message of run.messages) {
    if (message.attachments.length && message.role !== "user")
      throw Error("Attachments must belong to user messages");
    if (message.toolCalls.length && message.role !== "assistant")
      throw Error("Invalid tool call role");
    for (const call of message.toolCalls) {
      if (calls.has(call.callID)) throw Error("Duplicate tool call");
      calls.add(call.callID);
    }
    if (message.role === "tool") {
      if (
        !message.toolCallID ||
        !calls.has(message.toolCallID) ||
        results.has(message.toolCallID)
      )
        throw Error("Invalid tool result reference");
      results.add(message.toolCallID);
    } else if (message.toolCallID)
      throw Error("Unexpected tool result reference");
  }
  const attemptIDs = new Set<string>();
  for (const attempt of run.attempts) {
    if (
      attemptIDs.has(attempt.attemptID) ||
      !run.messages.some(
        (m) => m.messageID === attempt.turnID && m.role === "user",
      )
    )
      throw Error("Invalid attempt identity or turnID");
    attemptIDs.add(attempt.attemptID);
    if (attempt.messageID && !messages.has(attempt.messageID))
      throw Error("Missing attempt message reference");
    if (attempt.status === "completed" && !attempt.messageID)
      throw Error("Completed attempt has no message");
    if (
      !run.events.some(
        (e) =>
          e.type === "attempt" &&
          (e.data as { attemptID?: string } | null)?.attemptID ===
            attempt.attemptID,
      )
    )
      throw Error("Attempt has no transcript event");
  }
  const referenced = new Set<string>();
  for (const [i, event] of run.events.entries()) {
    if (
      event.sequence !== i + 1 ||
      !run.messages.some(
        (m) => m.messageID === event.turnID && m.role === "user",
      )
    )
      throw Error("Invalid event ordering or turnID");
    const reference =
      event.data &&
      typeof event.data === "object" &&
      !Array.isArray(event.data) &&
      "messageID" in event.data
        ? event.data.messageID
        : undefined;
    if (
      reference !== undefined &&
      (typeof reference !== "string" || !messages.has(reference))
    )
      throw Error("Missing event message reference");
    if (event.type === "message" || event.type === "toolResult") {
      const messageID = (event.data as { messageID?: string } | null)
        ?.messageID;
      if (!messageID || !messages.has(messageID))
        throw Error("Missing event message reference");
      referenced.add(messageID);
    }
  }
  for (const message of run.messages) {
    if (message.role !== "system" && !referenced.has(message.messageID))
      throw Error("Message has no transcript event");
  }
  for (const receipt of run.hookReceipts) {
    if (!run.events.some((e) => e.eventID === receipt.eventID))
      throw Error("Missing hook event reference");
  }
  if (
    new Set(run.skills.map((s) => s.skillID)).size !== run.skills.length ||
    run.agent.skillIDs.some((id) => !run.skills.some((s) => s.skillID === id))
  )
    throw Error("Missing or duplicate skill snapshot");
  if (run.version === 4) {
    const tools = run.toolSnapshots.map((tool) => normalizeStoredTool(tool));
    if (
      new Set(tools.map((t) => t.toolID)).size !== tools.length ||
      run.agent.toolIDs.some((id) => !tools.some((t) => t.toolID === id))
    )
      throw Error("Missing or duplicate tool snapshot");
  }
  validateCompactionState(run);
  attachments(run);
}
function documents(service: Service, run: Run) {
  return {
    "run.json": encodeRun(run),
    "transcript.json": service.transcript(run),
    "configuration.json": {
      agent: run.agent,
      skills: run.skills,
      tools: run.toolSnapshots,
    },
    "result.json": { execution: encodeRun(run).execution, result: run.result },
  };
}
async function regularRead(file: string) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
      throw Error("Invalid bundle file");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}
export async function exportRun(
  service: Service,
  runID: string,
  destination: string,
  dryRun: boolean,
) {
  if (!path.isAbsolute(destination))
    throw invalidInput("Export destination must be absolute");
  const parent = await realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const home = await realpath(service.storage.home);
  const relative = path.relative(home, target);
  if (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + path.sep) &&
      !path.isAbsolute(relative) &&
      !relative.startsWith("exports" + path.sep))
  )
    throw invalidInput(
      "Exports inside the runtime home must be below exports/",
    );
  try {
    await lstat(target);
    throw new NightcrewError(
      "resource.destinationExists",
      "Export destination already exists",
      9,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const run = await service.storage.read(runID);
  validate(run, runID);
  const result = {
    runID,
    destination: target,
    changed: !dryRun,
    revision: run.revision,
    lastEventSequence: run.events.at(-1)?.sequence ?? 0,
  };
  if (dryRun) return result;
  const docs = documents(service, run);
  const files = filenames.map((name) => {
    const data = encode(docs[name]);
    return { name, data };
  });
  if (files.some(({ data }) => data.length > 64 * 1024 * 1024))
    throw invalidInput("Export document exceeds 64 MB");
  const manifest = {
    version: 1,
    runID,
    revision: result.revision,
    lastEventSequence: result.lastEventSequence,
    files: files.map(({ name, data }) => ({
      path: name,
      bytes: data.length,
      sha256: digest(data),
    })),
    attachments: attachments(run),
  };
  checkpoint();
  await mkdir(target, { mode: 0o700 });
  const created: string[] = [];
  try {
    for (const { name, data } of [
      ...files,
      { name: "manifest.json", data: encode(manifest) },
    ]) {
      checkpoint();
      const file = path.join(target, name);
      await writeFile(file, data, { flag: "wx", mode: 0o600 });
      created.push(file);
    }
  } catch (error) {
    for (const file of created) await unlink(file).catch(() => {});
    await rmdir(target).catch(() => {});
    throw error;
  }
  return result;
}
export async function verifyRun(
  service: Service,
  runID: string,
  bundle?: string,
) {
  const checks: string[] = [],
    errors: string[] = [];
  let run: Run | undefined;
  try {
    if (bundle !== undefined) {
      if (!path.isAbsolute(bundle))
        throw invalidInput("Bundle path must be absolute");
      const stat = await lstat(bundle);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw Error("Invalid bundle directory");
      const manifest = manifestSchema.parse(
        JSON.parse(
          (await regularRead(path.join(bundle, "manifest.json"))).toString(),
        ),
      );
      if (
        manifest.runID !== runID ||
        new Set(manifest.files.map((f) => f.path)).size !== filenames.length
      )
        throw Error("Invalid manifest identity or file inventory");
      const docs: Record<string, unknown> = {};
      for (const file of manifest.files) {
        checkpoint();
        const bytes = await regularRead(path.join(bundle, file.path));
        if (bytes.length !== file.bytes || digest(bytes) !== file.sha256)
          throw Error("Checksum mismatch: " + file.path);
        docs[file.path] = JSON.parse(bytes.toString());
      }
      checks.push("fileChecksums");
      run = decodeRun(runProjectionSchema.parse(docs["run.json"]));
      const configuration = docs["configuration.json"] as {
        agent?: unknown;
        skills?: unknown;
      };
      if (configuration?.agent)
        configuration.agent = agentSchema.parse(configuration.agent);
      if (configuration?.skills)
        configuration.skills = z.array(skillSchema).parse(configuration.skills);
      docs["transcript.json"] = z
        .array(transcriptEntrySchema)
        .parse(docs["transcript.json"]);
      docs["run.json"] = encodeRun(run);
      if (
        run.revision !== manifest.revision ||
        (run.events.at(-1)?.sequence ?? 0) !== manifest.lastEventSequence
      )
        throw Error("Manifest snapshot mismatch");
      if (canonical(attachments(run)) !== canonical(manifest.attachments))
        throw Error("Attachment checksum mismatch");
      for (const [name, doc] of Object.entries(documents(service, run))) {
        if (canonical(doc) !== canonical(docs[name]))
          throw Error("Inconsistent bundle document: " + name);
      }
      checks.push("attachmentChecksums", "bundleConsistency");
    } else {
      run = await service.storage.read(runID);
    }
    checks.push("schema");
    validate(run, runID);
    checks.push(
      "identity",
      "eventOrdering",
      "messageAndToolReferences",
      "attachmentEncoding",
    );
  } catch (error) {
    checkpoint();
    errors.push(
      error instanceof z.ZodError
        ? "Invalid run or manifest schema"
        : error instanceof Error
          ? error.message
          : "Verification failed",
    );
  }
  return {
    runID,
    valid: errors.length === 0,
    checks,
    errors,
    revision: run?.revision ?? null,
    lastEventSequence: run?.events.at(-1)?.sequence ?? null,
  };
}
