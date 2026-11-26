import { randomUUID } from "node:crypto";
import path from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import { z } from "zod";
import {
  runProjectionSchema,
  runStateRecordSchema,
  type StoredRun,
} from "../schemas/run.js";
import { atomicJSON, claimJSON, readJSON } from "./files.js";
import { fingerprint } from "../utils/json.js";

const documentEvent = z.strictObject({
  eventID: z.uuid(),
  sequence: z.number().int().positive(),
  at: z.iso.datetime(),
  turnID: z.uuid(),
  type: z.string(),
  data: z.record(z.string(), z.json()),
});
export const runDocumentSchema = runStateRecordSchema.extend({
  messages: z.array(z.record(z.string(), z.json())),
  events: z.array(documentEvent),
});
export type RunDocument = z.infer<typeof runDocumentSchema>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const scalarEvents: Record<string, string> = {
  interactive: "turnPriorityChanged",
  parentRunID: "parentLinked",
  triggerSource: "triggerSubmitted",
  contextUsage: "contextMeasured",
  recovery: "toolLoopLimited",
  deliveryExpected: "deliveryExpected",
  evaluation: "evalStateChanged",
  compaction: "compactionChanged",
};
const arrays: Record<string, { key: string; event: string }> = {
  attempts: { key: "attemptID", event: "generationCheckpointed" },
  compactions: { key: "checkpointID", event: "compactionCommitted" },
  hookReceipts: { key: "receiptID", event: "hookInvocationChanged" },
  validations: { key: "messageID", event: "outputValidated" },
  capabilityRefreshes: { key: "at", event: "capabilitiesRefreshed" },
};
/** Engine arrays are projections. The single document owns messages and recorded events. */
export function projectDocument(document: RunDocument): StoredRun {
  const projection: any = {
    version: 4,
    messages: [],
    events: [],
    pendingInputs: [],
    triggerHistory: [],
    attempts: [],
    compactions: [],
    hookReceipts: [],
    validations: [],
    capabilityRefreshes: [],
    result: null,
  };
  const messages = new Map(document.messages.map((m: any) => [m.messageID, m]));
  if (messages.size !== document.messages.length)
    throw Error("Duplicate document message");
  if (
    new Set(document.events.map((e) => e.eventID)).size !==
    document.events.length
  )
    throw Error("Duplicate document event");
  if (
    !document.messages.some(
      (m) => m.messageID === document.turnID && m.role === "user",
    )
  )
    throw Error("Turn must reference a user message");
  const active = new Set<string>(),
    pending = new Map<string, any>(),
    configurations = new Map<string, any>();
  const records = new Map<string, Map<string, any>>(
    Object.keys(arrays).map((k) => [k, new Map()]),
  );
  for (const [index, event] of document.events.entries()) {
    const d: any = event.data;
    if (event.sequence !== index + 1)
      throw Error("Invalid document event order");
    if (event.type === "configurationChanged")
      configurations.set(d.configurationID, d.configuration);
    else if (event.type === "messageRecorded") active.add(d.messageID);
    else if (event.type === "turnQueued") pending.set(d.messageID, d);
    else if (event.type === "turnDequeued") pending.delete(d.messageID);
    else if (event.type === "lifecycleRecorded")
      projection.events.push(d.event);
    else if (event.type === "triggerHistoryRecorded")
      projection.triggerHistory.push(d.source);
    else if (Object.values(scalarEvents).includes(event.type)) {
      const field = Object.keys(scalarEvents).find(
        (k) => scalarEvents[k] === event.type,
      )!;
      if (field === "evaluation" && d.value === null)
        delete projection.evaluation;
      else projection[field] = d.value;
    } else {
      const field = Object.keys(arrays).find(
        (k) => arrays[k]!.event === event.type,
      );
      if (!field) throw Error("Unknown run event: " + event.type);
      records.get(field)!.set(d.key, d.value);
    }
  }
  const config = configurations.get(document.configurationID);
  if (!config || fingerprint(config) !== document.configurationID)
    throw Error("Invalid configuration snapshot");
  Object.assign(projection, {
    agent: config.agent,
    skills: config.skills,
    toolSnapshots: config.tools,
  });
  const message = (id: string) => {
    const m = messages.get(id);
    if (!m) throw Error("Missing message reference");
    const { turnID: _turnID, ...value } = m;
    return value;
  };
  projection.messages = [...active].map(message);
  projection.pendingInputs = [...pending.values()].map((p) => ({
    message: message(p.messageID),
    source: p.source,
    cancelled: p.cancelled,
    ...(p.configuration
      ? {
          agent: p.configuration.agent,
          skills: p.configuration.skills,
          tools: p.configuration.tools,
        }
      : {}),
  }));
  for (const [key, values] of records) projection[key] = [...values.values()];
  const {
    configurationID: _configurationID,
    inFlight: _inFlight,
    messages: _messages,
    events: _events,
    ...metadata
  } = document;
  Object.assign(projection, metadata);
  const completed = [...projection.events]
    .reverse()
    .find((e) => e.type === "completed" && e.turnID === document.turnID);
  projection.result =
    document.execution.state === "completed" && completed?.data.messageID
      ? (projection.messages.find(
          (m: any) => m.messageID === completed.data.messageID,
        )?.content ?? null)
      : null;
  return runProjectionSchema.parse(projection);
}
export function recordDocument(
  record: StoredRun,
  previous?: RunDocument,
): RunDocument {
  const prior = previous ? projectDocument(previous) : undefined;
  const events = structuredClone(previous?.events ?? []);
  const messages = new Map<string, any>(
    (previous?.messages ?? []).map((m: any) => [m.messageID, m]),
  );
  const add = (type: string, data: any) =>
    events.push({
      eventID: randomUUID(),
      sequence: events.length + 1,
      at: record.updatedAt,
      turnID: record.turnID,
      type,
      data: JSON.parse(JSON.stringify(data)),
    });
  const config = JSON.parse(
    JSON.stringify({
      agent: record.agent,
      skills: record.skills,
      tools: record.toolSnapshots,
    }),
  );
  const configurationID = fingerprint(config);
  if (configurationID !== previous?.configurationID)
    add("configurationChanged", { configurationID, configuration: config });
  const turns = new Map<string, string>();
  for (const e of record.events)
    if ("messageID" in e.data && typeof e.data.messageID === "string")
      turns.set(e.data.messageID, e.turnID);
  const oldMessages = new Map(prior?.messages.map((m) => [m.messageID, m]));
  for (const m of record.messages) {
    messages.set(m.messageID, {
      ...m,
      turnID: turns.get(m.messageID) ?? record.turnID,
    });
    if (!oldMessages.has(m.messageID))
      add("messageRecorded", { messageID: m.messageID });
  }
  const oldPending = new Map(
    prior?.pendingInputs.map((p) => [p.message.messageID, p]),
  );
  for (const p of record.pendingInputs) {
    messages.set(p.message.messageID, {
      ...p.message,
      turnID: p.message.messageID,
    });
    if (!same(p, oldPending.get(p.message.messageID)))
      add("turnQueued", {
        messageID: p.message.messageID,
        source: p.source,
        cancelled: p.cancelled,
        configuration: p.agent
          ? { agent: p.agent, skills: p.skills ?? [], tools: p.tools ?? [] }
          : null,
      });
  }
  for (const p of prior?.pendingInputs ?? [])
    if (
      !record.pendingInputs.some(
        (n) => n.message.messageID === p.message.messageID,
      )
    )
      add("turnDequeued", { messageID: p.message.messageID });
  for (const [field, type] of Object.entries(scalarEvents)) {
    const value = (record as any)[field] ?? null;
    if (!prior || !same(value, (prior as any)[field] ?? null))
      add(type, { value });
  }
  for (const [field, definition] of Object.entries(arrays)) {
    const old = new Map<string, unknown>(
      ((prior as any)?.[field] ?? []).map((v: any) => [v[definition.key], v]),
    );
    for (const value of (record as any)[field])
      if (!same(value, old.get(value[definition.key]))) {
        // A generation is a mutable checkpoint until settled, not one event per token.
        const existing =
          field === "attempts"
            ? events.find(
                (e) =>
                  e.type === definition.event &&
                  e.data.key === value[definition.key],
              )
            : undefined;
        if (existing)
          existing.data = {
            key: value[definition.key],
            value: JSON.parse(JSON.stringify(value)),
          };
        else add(definition.event, { key: value[definition.key], value });
      }
  }
  if (
    prior &&
    (!same(record.events.slice(0, prior.events.length), prior.events) ||
      !same(
        record.triggerHistory.slice(0, prior.triggerHistory.length),
        prior.triggerHistory,
      ))
  )
    throw Error("Run lifecycle history is append-only");
  for (const event of record.events.slice(prior?.events.length ?? 0))
    add("lifecycleRecorded", { event });
  for (const source of record.triggerHistory.slice(
    prior?.triggerHistory.length ?? 0,
  ))
    add("triggerHistoryRecorded", { source });
  const generation = [...record.attempts]
    .reverse()
    .find((a) => a.status === "running");
  return runDocumentSchema.parse({
    version: 4,
    runID: record.runID,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    turnID: record.turnID,
    configurationID,
    execution: record.execution,
    activeMs: record.activeMs,
    ...(generation || record.compaction
      ? {
          inFlight: {
            ...(generation ? { generationID: generation.attemptID } : {}),
            ...(record.compaction
              ? { compactionID: record.compaction.requestID }
              : {}),
          },
        }
      : {}),
    messages: [...messages.values()],
    events,
  });
}
export class RunDocuments {
  constructor(readonly root: string) {}
  private file(id: string) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id))
      throw Error("Invalid run ID");
    return path.join(this.root, id, "state.json");
  }
  async document(id: string) {
    return readJSON(this.file(id), runDocumentSchema, 64 * 1024 * 1024);
  }
  async read(id: string) {
    return projectDocument(await this.document(id));
  }
  async write(record: StoredRun, initial = false) {
    const document = recordDocument(
      record,
      initial ? undefined : await this.document(record.runID),
    );
    if (!initial) {
      await atomicJSON(this.file(record.runID), document, 64 * 1024 * 1024);
      return;
    }
    // Publish a new directory only after state.json exists, so concurrent scans
    // cannot mistake a run being created for an unreadable run.
    this.file(record.runID);
    const temporary = path.join(
      this.root,
      "." + record.runID + "-" + randomUUID(),
    );
    await mkdir(temporary, { mode: 0o700 });
    try {
      await claimJSON(
        path.join(temporary, "state.json"),
        document,
        64 * 1024 * 1024,
      );
      await rename(temporary, path.join(this.root, record.runID));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
