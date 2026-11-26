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

import {
  documentEventSchema,
  documentMessageSchema,
  scalarEvents,
  collectionEvents,
  isLifecycleEvent,
  type DocumentEvent,
  type QueuedTurn,
  type Configuration,
} from "./runEvents.js";
import { messageSchema, userMessageSchema } from "../schemas/common.js";

export const runDocumentSchema = runStateRecordSchema.extend({
  messages: z.array(documentMessageSchema),
  events: z.array(documentEventSchema),
});
export type RunDocument = z.infer<typeof runDocumentSchema>;
const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const scalarFields = new Map<string, keyof typeof scalarEvents>(
  Object.entries(scalarEvents).map(([key, type]) => [
    type,
    key as keyof typeof scalarEvents,
  ]),
);
const collectionFields = new Map<string, keyof typeof collectionEvents>(
  Object.entries(collectionEvents).map(([key, definition]) => [
    definition.event,
    key as keyof typeof collectionEvents,
  ]),
);
/** Engine arrays are projections. The single document owns messages and recorded events. */
export function projectDocument(document: RunDocument): StoredRun {
  const projection: Partial<StoredRun> = {
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
  const messages = new Map(document.messages.map((m) => [m.messageID, m]));
  if (messages.size !== document.messages.length)
    throw Error("Duplicate document message");
  if (
    new Set(document.events.map((e) => e.eventID)).size !==
    document.events.length
  )
    throw Error("Duplicate document event");
  if (
    !document.messages.some(
      (m) =>
        m.messageID === document.turnID && "role" in m && m.role === "user",
    )
  )
    throw Error("Turn must reference a user message");
  const active = new Set<string>(),
    pending = new Map<string, QueuedTurn>();
  let configuration:
    | { configurationID: string; configuration: Configuration }
    | undefined;
  const records = new Map<string, Map<string, unknown>>(
    Object.keys(collectionEvents).map((k) => [k, new Map()]),
  );
  for (const [index, event] of document.events.entries()) {
    if (event.sequence !== index + 1)
      throw Error("Invalid document event order");
    if (isLifecycleEvent(event)) {
      // Public transcript cursors count lifecycle events, independently of storage events.
      projection.events!.push({
        ...event,
        sequence: projection.events!.length + 1,
      });
    } else if (event.type === "configurationChanged")
      configuration = event.data;
    else if (event.type === "messageRecorded") active.add(event.data.messageID);
    else if (event.type === "turnQueued")
      pending.set(event.data.messageID, event.data);
    else if (event.type === "turnDequeued")
      pending.delete(event.data.messageID);
    else if (event.type === "triggerHistoryRecorded")
      projection.triggerHistory!.push(event.data.source);
    else {
      const field = scalarFields.get(event.type);
      if (field) {
        if (!("value" in event.data)) throw Error("Missing scalar value");
        if (field === "evaluation" && event.data.value === null)
          delete projection.evaluation;
        else Object.assign(projection, { [field]: event.data.value });
      } else {
        const field = collectionFields.get(event.type);
        if (!field || !("value" in event.data))
          throw Error("Unknown run event: " + event.type);
        const key = String(
          (event.data.value as Record<string, unknown>)[collectionEvents[field].key],
        );
        records.get(field)!.set(key, event.data.value);
      }
    }
  }

  const config = configuration?.configuration;
  if (!config || fingerprint(config) !== configuration?.configurationID)
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
  projection.messages = [...active].map((id) =>
    messageSchema.parse(message(id)),
  );
  projection.pendingInputs = [...pending.values()].map((p) => ({
    message: userMessageSchema.parse(message(p.messageID)),
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
  for (const [key, values] of records)
    Object.assign(projection, { [key]: [...values.values()] });
  const {
    version: _version,
    messages: _messages,
    events: _events,
    ...metadata
  } = document;
  Object.assign(projection, metadata);
  const completed = [...projection.events!]
    .reverse()
    .find((e) => e.type === "completed" && e.turnID === document.turnID);
  const messageID =
    completed && "messageID" in completed.data
      ? completed.data.messageID
      : undefined;
  projection.result =
    document.execution.state === "completed" && messageID
      ? (projection.messages.find((m) => m.messageID === messageID)?.content ??
        null)
      : null;
  return runProjectionSchema.parse(projection);
}
export function recordDocument(
  record: StoredRun,
  previous?: RunDocument,
): RunDocument {
  const prior = previous ? projectDocument(previous) : undefined;
  const events = structuredClone(previous?.events ?? []);
  const messages = new Map<string, RunDocument["messages"][number]>(
    (previous?.messages ?? []).map((m) => [m.messageID, m]),
  );
  const add = (type: DocumentEvent["type"], data: unknown) =>
    events.push(
      documentEventSchema.parse({
        eventID: randomUUID(),
        sequence: events.length + 1,
        at: record.updatedAt,
        turnID: record.turnID,
        type,
        data: JSON.parse(JSON.stringify(data)),
      }),
    );
  const config = JSON.parse(
    JSON.stringify({
      agent: record.agent,
      skills: record.skills,
      tools: record.toolSnapshots,
    }),
  );
  const configurationID = fingerprint(config);
  if (
    !prior ||
    configurationID !==
      fingerprint({
        agent: prior.agent,
        skills: prior.skills,
        tools: prior.toolSnapshots,
      })
  )
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
  for (const field of Object.keys(
    scalarEvents,
  ) as (keyof typeof scalarEvents)[]) {
    const type = scalarEvents[field];
    const value = record[field] ?? null;
    if (!prior || !same(value, prior[field] ?? null)) add(type, { value });
  }
  for (const field of Object.keys(
    collectionEvents,
  ) as (keyof typeof collectionEvents)[]) {
    const definition = collectionEvents[field];
    const key = (value: object) =>
      String((value as Record<string, unknown>)[definition.key]);
    const old = new Map<string, unknown>(
      (prior?.[field] ?? []).map((v) => [key(v), v]),
    );
    for (const value of record[field])
      if (!same(value, old.get(key(value)))) {
        // A generation is a mutable checkpoint until settled, not one event per token.
        const existing =
          field === "attempts"
            ? events.find(
                (e) =>
                  e.type === definition.event &&
                  "value" in e.data &&
                  key(e.data.value as object) === key(value),
              )
            : undefined;
        if (existing)
          existing.data = {
            value: JSON.parse(JSON.stringify(value)),
          };
        else add(definition.event, { value });
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
    events.push({ ...event, sequence: events.length + 1 });
  for (const source of record.triggerHistory.slice(
    prior?.triggerHistory.length ?? 0,
  ))
    add("triggerHistoryRecorded", { source });
  return runDocumentSchema.parse({
    version: 10,
    runID: record.runID,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    turnID: record.turnID,
    execution: record.execution,
    activeMs: record.activeMs,
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
