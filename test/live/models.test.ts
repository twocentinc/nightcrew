// Excluded from npm test. Starts real llama.cpp workers only with explicit opt-in.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { startServer } from "../../dist/server/http.js";
import { tokenHash } from "../../dist/storage/config.js";
import { modelSchema } from "../../dist/schemas/model.js";
import { storeSchema } from "../../dist/schemas/config.js";

test(
  "real models: thinking, persistent restart, compaction and optional audio",
  {
    skip: process.env.NIGHTCREW_ALLOW_INFERENCE !== "1",
    timeout: 900000,
  },
  async (t) => {
    assert.ok(
      process.env.NIGHTCREW_LIVE_CONFIG!,
      "Provide NIGHTCREW_LIVE_CONFIG",
    );
    const settings = JSON.parse(
      (await readFile(process.env.NIGHTCREW_LIVE_CONFIG!, "utf8")).toString(),
    );
    const qwen = modelSchema.parse({ ...settings.qwen, contextTokens: 8192 });
    const granite = settings.granite
      ? modelSchema.parse({ ...settings.granite, contextTokens: 8192 })
      : null;
    assert.equal(qwen.kind, "chat");
    const home = await mkdtemp(path.join(tmpdir(), "nightcrew-live-"));
    t.diagnostic("Retained validation transcripts: " + home);
    const token = randomUUID();
    const store = storeSchema.parse({
      version: 5,
      config: {
        revision: 1,
        host: "127.0.0.1",
        port: 8888,
        interactionCooldownMs: 0,
        rootTokenHash: tokenHash(token),
        models: [qwen, ...(granite ? [granite] : [])],

        hooks: [],
        scheduler: {
          instantModelID: qwen.modelID,
          timersEnabled: false,
        },
      },
      agents: [],
      cooldownUntil: null,
    });
    await writeFile(path.join(home, "config.json"), JSON.stringify(store), {
      mode: 0o600,
    });
    let app: any;
    const start = async () =>
      (app = await startServer({
        home,
        port: 0,
        presence: async () => ({
          state: "away",
          reason: "isolated live validation",
          samplingHealthy: true,
          observedAt: new Date().toISOString(),
          diagnostic: null,
        }),
      }));
    await start();
    t.after(async () => {
      await app.close();
    });
    const rpc = async (
      name: any,
      request = {},
      resourceID: string | undefined = undefined,
    ) => {
      const response = await fetch(
        "http://127.0.0.1:" +
          (app.server.address() as import("node:net").AddressInfo).port +
          "/v1/operations/" +
          name.replaceAll(" ", "/"),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + token,
          },
          body: JSON.stringify({ request, resourceID }),
        },
      );
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      return result;
    };
    const wait = async (runID: string) => {
      for (let i = 0; i < 1200; i++) {
        const run = await app.service.storage.read(runID);
        if (["failed", "timedOut", "cancelled"].includes(run.state) || run.held)
          assert.fail(JSON.stringify(run.error));
        if (run.state === "completed") return run;
        await delay(500);
      }
      assert.fail("Live run did not finish in ten minutes");
    };
    const draft = (agentID: string, extra = {}) => ({
      agentID,
      name: agentID,
      systemPrompt: "Follow the user request concisely.",
      mode: "singleTurn",
      modelID: qwen.modelID,
      executionClass: "background",
      skillIDs: [],
      toolIDs: [],
      enabled: true,
      thinking: false,
      maxOutputTokens: 512,
      timeoutMs: 600000,
      ...extra,
    });
    const message = (content: string, thinking?: any) => ({
      messageID: randomUUID(),
      content,
      attachments: [],
      ...(thinking === undefined ? {} : { thinking }),
    });
    await rpc("agents create", {
      agent: draft("live-persistent", { contextMode: "persistent" }),
    });
    let accepted = await rpc(
      "agents run",
      {
        message: message(
          "Remember the secret word lavender. Reply with hello world.",
          true,
        ),
      },
      "live-persistent",
    );
    let run = await wait(accepted.runID);
    let answer = run.messages
      .filter((m?: any) => m.role === "assistant")
      .at(-1);
    assert.equal(answer.thinking, true);
    assert.ok(
      answer.reasoningContent?.trim(),
      "Model must expose reasoning with thinking enabled",
    );
    const originalID = run.runID;
    await app.close();
    await start();
    accepted = await rpc(
      "agents run",
      { message: message("What was the secret word?") },
      "live-persistent",
    );
    assert.equal(accepted.runID, originalID);
    run = await wait(originalID);
    answer = run.messages.filter((m?: any) => m.role === "assistant").at(-1);
    assert.equal(answer.thinking, false);
    assert.ok(!answer.reasoningContent);
    assert.match(answer.content, /lavender/i);

    const config = (await rpc("config get")).config;
    await rpc("config update", {
      changes: {
        models: config.models.map((m?: any) =>
          m.modelID === qwen.modelID
            ? { ...m, compactionThresholdTokens: 1200 }
            : m,
        ),
      },
    });
    const summarizer = JSON.parse(
      (
        await readFile(
          new URL("../../examples/summarizer/agent.json", import.meta.url),
          "utf8",
        )
      ).toString(),
    ).agent;
    await rpc("agents create", {
      agent: {
        ...summarizer,
        agentID: "live-summary",
        modelID: qwen.modelID,
        enabled: true,
        maxOutputTokens: 512,
      },
    });
    await rpc("agents create", {
      agent: draft("live-compact", {
        contextMode: "persistent",
        compaction: {
          handler: { type: "agent" as const, agentID: "live-summary" },
        },
      }),
    });
    let compactID;
    for (let i = 0; i < 8; i++) {
      accepted = await rpc(
        "agents run",
        {
          message: message(
            "Remember code lavender. Summarize these observations briefly: " +
              "The garden has seven trees and a blue gate. ".repeat(30),
          ),
        },
        "live-compact",
      );
      compactID = accepted.runID;
      run = await wait(compactID);
      if (run.compactions.length) break;
    }
    assert.ok(run.compactions.length, "Expected a real compaction checkpoint");
    assert.ok(run.compactions.at(-1).childRunID);
    assert.equal(run.runID, compactID);
    if (granite) {
      assert.equal(granite.kind, "audio");
      assert.ok(
        settings.audioFile,
        "Granite validation requires a short WAV audioFile",
      );
      await rpc("agents create", {
        agent: draft("live-audio", {
          modelID: granite.modelID,
          maxOutputTokens: 512,
          sampling: { temperature: 0 },
        }),
      });
      accepted = await rpc(
        "agents run",
        {
          message: {
            ...message("Transcribe this recording."),
            attachments: [
              {
                name: "sample.wav",
                mediaType: "audio/wav" as const,
                dataBase64: (await readFile(settings.audioFile)).toString(
                  "base64",
                ),
              },
            ],
          },
        },
        "live-audio",
      );
      run = await wait(accepted.runID);
      assert.ok(run.result?.trim());
      if (settings.expectedAudioText)
        assert.ok(
          run.result
            .toLowerCase()
            .includes(settings.expectedAudioText.toLowerCase()),
        );
    } else t.diagnostic("Granite omitted: no audio model configured");
  },
);
