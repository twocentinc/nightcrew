import { settings, agentDraft } from "./fixtures.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Storage } from "../dist/storage/store.js";
import { initializeHome } from "../dist/storage/config.js";
import { Service } from "../dist/engine/service.js";
import { manage as rawmanage } from "../dist/utils/commands/management.js";
const manage: (...args: Parameters<typeof rawmanage>) => Promise<any> =
  rawmanage;
import {
  operations,
  callOperation as rawcallOperation,
} from "../dist/utils/commands/operations.js";
const callOperation: (
  ...args: Parameters<typeof rawcallOperation>
) => Promise<any> = rawcallOperation;
import { runOutcome, loopProblem } from "../dist/engine/supervision.js";
import {validateSummaryEvidence} from "../dist/engine/compaction/evidence.js";
import {compactionInstructions} from "../dist/engine/compaction/format.js";
const input = () => ({
  messageID: randomUUID(),
  content: "perform the task",
  attachments: [],
});
const validation = {
  validator: {
    type: "json-schema" as const,
    schema: {
      type: "object" as const,
      properties: { answer: { type: "number" as const } },
      required: ["answer"],
      additionalProperties: false,
    },
  },
  repairAttempts: 1,
};
async function until(fn?: any) {
  for (let i = 0; i < 500; i++) {
    const value = await fn();
    if (value) return value;
    await delay(10);
  }
  throw Error("timeout");
}
async function fixture(
  t: import("node:test").TestContext,
  generate?: any,
  extra = {},
  hooks: any[] = [],
) {
  const home = await mkdtemp(path.join(tmpdir(), "nc-supervision-"));
  await initializeHome(
    home,
    settings.parse({
      host: "127.0.0.1",
      port: 6970,
      interactionCooldownMs: 0,
      models: [
        {
          modelID: "q",
          kind: "chat" as const,
          weightsPath: "/unused",
          projectorPath: null,
          idleUnloadMs: 0,
        },
      ],
      slots: [
        {
          slotID: "instant",
          modelID: "q",
          index: 0,
          contextTokens: 4096,
          instant: true,
        },
      ],
      hooks,
    }),
  );
  const calls: any[] = [];
  const runtime = {
    status: () => [],
    close: async () => {},
    generate: async (
      request?: any,
      signal?: any,
      onDelta?: any,
      onEvidence?: any,
    ) => {
      calls.push(request);
      return {
        text: "done",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        ...(await generate(request, calls.length, signal, {
          onDelta,
          onEvidence,
        })),
      };
    },
  };
  let service!: Service;
  const start = async () => {
    service = new Service(new Storage(home), runtime, async () => ({
      state: "away",
      reason: "test",
      samplingHealthy: true,
      observedAt: new Date().toISOString(),
      diagnostic: null,
    }));
    await service.initialize();
  };
  await start();
  t.after(async () => {
    await service.close();
    await rm(home, { recursive: true, force: true });
  });
  await service.createAgent(
    agentDraft.parse({
      agentID: "worker",
      name: "worker",
      systemPrompt: "Return the requested result.",
      mode: "single-turn",
      modelID: "q",
      slotID: "instant",
      skillIDs: [],
      toolIDs: [],
      enabled: true,
      timeoutMs: 30000,
      thinking: false,
      maxOutputTokens: 128,
      finishSchema: validation.validator.schema,
      ...extra,
    }),
  );
  const submit = async () => {
    const a = await service.submit("worker", input());
    return until(async () => {
      const r = await service.run(a.runID);
      return ["completed", "failed", "timedOut"].includes(r.state) && r;
    });
  };
  return {
    home,
    calls,
    submit,
    get service() {
      return service;
    },
    restart: async () => {
      await service.close();
      await start();
    },
  };
}

const finish = (value?: any) => ({
  text: "",
  toolCalls: [
    {
      callID: randomUUID(),
      name: "finish",
      arguments: typeof value === "string" ? value : JSON.stringify(value),
    },
  ],
});
test("finish validates and commits a result without executable dispatch, survives restart", async (t) => {
  const f = await fixture(t, async (request?: any) => {
    assert.deepEqual(
      request.tools.map((x?: any) => x.name),
      ["finish"],
    );
    return finish({ answer: 42 });
  });
  f.service["toolStep"]["invokeTool"] = async () => {
    throw Error("finish must not dispatch");
  };
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.deepEqual(JSON.parse(r.result), { answer: 42 });
  assert.equal(f.calls.length, 1);
  await f.restart();
  assert.equal((await f.service.run(r.runID)).result, r.result);
  assert.equal(f.calls.length, 1);
});
test("ordinary text and malformed finish get corrected within three attempts", async (t) => {
  const f = await fixture(t, async (req?: any, n?: any) =>
    n === 1
      ? { text: "I am done" }
      : n === 2
        ? finish({ answer: "wrong" })
        : finish({ answer: 42 }),
  );
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(f.calls.length, 3);
  assert.ok(
    r.messages.some(
      (m?: any) => m.role === "tool" && m.content.includes("invalid_finish"),
    ),
  );
  assert.deepEqual(
    f.calls[2].tools.map((t: import("node:test").TestContext) => t.name),
    ["finish"],
  );
});
test("three invalid finishes fail instead of completing", async (t) => {
  const f = await fixture(t, async () => finish("{"));
  const r = await f.submit();
  assert.equal(r.state, "failed");
  assert.equal(r.result, null);
  assert.equal(f.calls.length, 3);
});
test("mixed finish batch executes neither finish nor sibling", async (t) => {
  const f = await fixture(
    t,
    async (_?: any, n?: any) =>
      n === 1
        ? {
            text: "",
            toolCalls: [
              ...finish({ answer: 42 }).toolCalls,
              { callID: randomUUID(), name: "danger", arguments: "{}" },
            ],
          }
        : finish({ answer: 43 }),
    { mode: "agent-loop" },
  );
  let invoked = 0;
  f.service["toolStep"]["invokeTool"] = async () => {
    invoked++;
    return { ok: true };
  };
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(invoked, 0);
  assert.equal(JSON.parse(r.result).answer, 43);
  assert.equal(
    r.messages.filter(
      (m?: any) => m.role === "tool" && m.content.includes("invalid_finish"),
    ).length,
    2,
  );
});
test("finish remains available after the ordinary tool budget", async (t) => {
  const f = await fixture(
    t,
    async (_?: any, n?: any) =>
      n === 1
        ? {
            text: "",
            toolCalls: [
              { callID: randomUUID(), name: "example", arguments: "{}" },
            ],
          }
        : finish({ answer: 42 }),
    { mode: "agent-loop", maxToolCalls: 1 },
  );
  let invoked = 0;
  f.service["toolStep"]["invokeTool"] = async () => {
    invoked++;
    return { ok: true };
  };
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(invoked, 1);
  assert.deepEqual(
    f.calls[1].tools.map((t: import("node:test").TestContext) => t.name),
    ["finish"],
  );
});
test("opt-in finish retains existing output validation", async (t) => {
  const f = await fixture(
    t,
    async (_?: any, n?: any) => finish({ answer: n }),
    {
      outputValidation: {
        validator: {
          type: "json-schema" as const,
          schema: {
            type: "object" as const,
            properties: { answer: { const: 2 } },
            required: ["answer"],
          },
        },
        repairAttempts: 1,
      },
    },
  );
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(JSON.parse(r.result).answer, 2);
  assert.deepEqual(
    r.validations.map((v?: any) => v.status),
    ["failed", "passed"],
  );
  assert.ok(
    r.validations.every((v?: any) =>
      r.messages.some((m?: any) => m.messageID === v.messageID),
    ),
  );
});

test("duplicate finish fields are rejected with specific repair feedback before completion", async (t) => {
  const f = await fixture(t, async (req?: any, n?: any) => {
    if (n === 1) return finish('{"answer":1,"answer":42}');
    assert.ok(
      req.messages.some(
        (m?: any) =>
          m.role === "tool" && m.content.includes("separate objects"),
      ),
    );
    return finish({ answer: 42 });
  });
  const r = await f.submit();
  assert.equal(r.state, "completed");
  assert.equal(f.calls.length, 2);
  assert.deepEqual(JSON.parse(r.result), { answer: 42 });
  assert.equal(r.events.filter((e?: any) => e.type === "completed").length, 1);
});
test("structured JSON detects escaped duplicate keys without rejecting siblings or string contents", async () => {
  const { parseOutputJSON, DuplicateJSONKeyError } =
    await import("../dist/engine/supervision.js");
  for (const text of [
    '{"items":[{"title":"a","title":"b"}]}',
    '{"a":1,"\\u0061":2}',
    '{"nested":{"x":1,"x":2}}',
  ])
    assert.throws(() => parseOutputJSON(text), DuplicateJSONKeyError);
  assert.deepEqual(
    parseOutputJSON(
      '{"items":[{"title":"a"},{"title":"b"}],"text":"commas, braces {} and \\"quotes\\""}',
    ),
    {
      items: [{ title: "a" }, { title: "b" }],
      text: 'commas, braces {} and "quotes"',
    },
  );
  assert.throws(() => parseOutputJSON('{"a":'), SyntaxError);
});

test("ordinary JSON output validation rejects duplicate keys even when last value matches schema", async () => {
  const { validateOutput } = await import("../dist/engine/supervision.js");
  const verdict = await validateOutput(
    {
      agent: { outputValidation: validation },
      segment: 0,
    } as unknown as Parameters<typeof validateOutput>[0],
    {
      role: "assistant",
      attachments: [],
      toolCalls: [],
      toolCallID: null,
      messageID: randomUUID(),
      content: '{"answer":0,"answer":42}',
    },
    "/unused",
    new AbortController().signal,
  );
  assert.equal(verdict.status, "failed");
  assert.match(verdict.reason, /Duplicate JSON key/);
  assert.match(verdict.reason, /separate objects/);
});
