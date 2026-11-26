import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  runProjectionSchema,
  decodeRun,
  encodeRun,
} from "../dist/schemas/run.js";
import { executionSchema } from "../dist/schemas/execution.js";
import { eventSchema } from "../dist/schemas/event.js";
import { Context } from "../dist/engine/execution/context.js";
const at = "2026-01-01T00:00:00.000Z";
function fixture() {
  const messageID = randomUUID();
  return decodeRun(
    runProjectionSchema.parse({
      version: 4,
      runID: randomUUID(),
      revision: 1,
      createdAt: at,
      updatedAt: at,
      agent: {
        agentID: "test",
        name: "test",
        revision: 1,
        systemPrompt: "Test",
        mode: "singleTurn",
        modelID: "q",
        skillIDs: [],
        toolIDs: [],
        timeoutMs: 1000,
        enabled: false,
        createdAt: at,
        updatedAt: at,
      },
      skills: [],
      turnID: "00000000-0000-4000-8000-000000000000",
      execution: { state: "completed" },
      activeMs: 0,
      messages: [
        {
          messageID,
          role: "user",
          content: "test",
          attachments: [],
          toolCalls: [],
          toolCallID: null,
        },
      ],
      events: [
        {
          eventID: randomUUID(),
          sequence: 1,
          at,
          turnID: "00000000-0000-4000-8000-000000000000",
          type: "message",
          data: { messageID },
        },
        {
          eventID: randomUUID(),
          sequence: 2,
          at,
          turnID: "00000000-0000-4000-8000-000000000000",
          type: "completed",
          data: {},
        },
      ],
      result: "done",
      hookReceipts: [],
    }),
  );
}
test("run execution is one discriminated record, with explicit pause admission", () => {
  const run = fixture();
  run.state = "paused";
  run.pauseReason = "instant";
  assert.deepEqual(encodeRun(run).execution, {
    state: "paused",
    reason: "instant",
    resume: "automatic",
  });
  run.held = true;
  run.pauseReason = "manualStop";
  const stored = encodeRun(run);
  assert.deepEqual(stored.execution, {
    state: "paused",
    reason: "manualStop",
    resume: "manual",
  });
  for (const key of ["state", "held", "pauseReason", "error", "storageLimit"])
    assert.equal(key in stored, false);
  assert.equal(decodeRun(stored).held, true);
  for (const value of [
    { state: "completed", reason: "instant" },
    { state: "paused", reason: "manualStop", resume: "automatic" },
    { state: "paused", reason: "storageLimit", resume: "manual" },
    {
      state: "paused",
      reason: "instant",
      resume: "automatic",
      limit: { resource: "bytes", used: 1, maximum: 1 },
    },
  ])
    assert.equal(executionSchema.safeParse(value).success, false);
});
test("event payloads and tool snapshots reject invalid shapes", () => {
  const run = fixture();
  assert.equal(
    eventSchema.safeParse({ ...run.events[0], type: "attempt" }).success,
    false,
  );
  assert.equal(
    eventSchema.safeParse({
      ...run.events[0],
      data: { messageID: randomUUID(), arbitrary: true },
    }).success,
    false,
  );
  assert.equal(
    runProjectionSchema.safeParse({
      ...encodeRun(run),
      toolSnapshots: [{ anything: true }],
    }).success,
    false,
  );
  assert.equal(
    runProjectionSchema.safeParse({
      ...encodeRun(run),
      execution: { state: "completed" },
      held: false,
    }).success,
    false,
  );
});
test("count limits identify the actual resource and cannot be fixed by raising MB", () => {
  const run = fixture();
  const context = new Context({
    records: {
      event: (r, type, data) =>
        r.events.push(
          eventSchema.parse({
            eventID: randomUUID(),
            sequence: r.events.length + 1,
            at,
            turnID: r.turnID,
            type,
            data,
          }),
        ),
    },
  });
  run.messages = Array.from({ length: 9000 }, () => ({
    ...run.messages[0]!,
    messageID: randomUUID(),
  }));
  assert.deepEqual(context.storageLimit(run), {
    resource: "messages",
    used: 9000,
    maximum: 9000,
  });
  context.pauseForStorage(run);
  assert.equal(run.held, true);
  assert.match(run.error!.message, /raising storageLimitMB cannot/);
  assert.deepEqual(encodeRun(run).execution, {
    state: "paused",
    reason: "storageLimit",
    resume: "manual",
    error: run.error,
    limit: { resource: "messages", used: 9000, maximum: 9000 },
  });
  run.agent.storageLimitMB = 48;
  assert.equal(context.atStorageLimit(run), true);
});
test("receipts retain identity and reject missing event references", () => {
  const run = fixture();
  const first = {
    receiptID: randomUUID(),
    hookID: "delivery",
    eventID: run.events[1]!.eventID,
    startedAt: at,
    finishedAt: at,
    purpose: "delivery" as const,
    executablePath: "/old",
    status: "failed" as const,
    diagnostic: "failed",
  };
  run.hookReceipts = [first];
  assert.deepEqual(decodeRun(encodeRun(run)).hookReceipts, [first]);
  first.eventID = randomUUID();
  assert.throws(() => encodeRun(run), /Missing hook event/);
  run.hookReceipts = [first, first];
  assert.throws(() => encodeRun(run), /Duplicate/);
});

test("completed instant events retain model output-limit metadata", () => {
  const event = eventSchema.parse({
    eventID: randomUUID(),
    sequence: 1,
    at,
    turnID: "00000000-0000-4000-8000-000000000000",
    type: "completed",
    data: {
      text: "partial",
      toolCalls: [],
      usage: { inputTokens: 1, outputTokens: 1 },
      outputLimitReached: true,
    },
  });
  assert.deepEqual(event.data, {
    text: "partial",
    toolCalls: [],
    usage: { inputTokens: 1, outputTokens: 1 },
    outputLimitReached: true,
  });
});

test("historical hook attempts retain evidence but latest invocation determines outcome", async () => {
  const {runOutcome} = await import("../dist/engine/supervision.js");
  const run = fixture();
  const receipt = { receiptID: randomUUID(), hookID: "delivery", eventID: run.events[1]!.eventID,
    startedAt: at, finishedAt: at, purpose: "delivery" as const, executablePath: "/old",
    status: "failed" as const, diagnostic: "failed" };
  run.hookReceipts = [receipt, {...receipt, receiptID: randomUUID(), status: "succeeded", diagnostic: null}];
  assert.equal(runOutcome(run).delivery, "succeeded");
  assert.equal("nextAction" in runOutcome(run), false);
  assert.equal(run.hookReceipts.length, 2);
});
