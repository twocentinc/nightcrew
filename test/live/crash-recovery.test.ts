// Opt-in real inference. Stop the production daemon before running this fixture.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fork, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { storeSchema } from "../../dist/contracts.js";
import { tokenHash } from "../../dist/storage.js";
const alive = (pid?: any) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
test(
  "SIGKILL recovery during real generation, compaction and ambiguous delivery",
  { skip: process.env.NIGHTCREW_ALLOW_INFERENCE !== "1", timeout: 900000 },
  async (t) => {
    const settings = JSON.parse(
      (await readFile(process.env.NIGHTCREW_LIVE_CONFIG!, "utf8")).toString(),
    );
    const home = await mkdtemp(path.join(tmpdir(), "nc-crash-"));
    const evidence = {
      home,
      startedAt: new Date().toISOString(),
      checks: [] as Array<Record<string, unknown>>,
      presence: "synthetic away; presence is not tested",
      modelID: settings.qwen.modelID,
    };
    const record = async (name?: any, details = {}) => {
      evidence.checks.push({ name, ...details });
      await writeFile(
        home + "/crash-recovery.json",
        JSON.stringify(evidence, null, 2),
      );
      console.log(JSON.stringify({ home, name, ...details }));
    };
    const token = randomUUID();
    let child: any, port: any;
    const owned = new Set<number>();
    const received: any[] = [];
    let ambiguous = false;
    const receiver = createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      received.push(JSON.parse(body));
      await writeFile(home + "/received.json", JSON.stringify(received));
      if (ambiguous && received.length === 1) return;
      res.end(
        JSON.stringify({ success: true, messageId: String(received.length) }),
      );
    });
    await new Promise<void>((resolve) =>
      receiver.listen(0, "127.0.0.1", resolve),
    );
    const endpoint =
      "http://127.0.0.1:" +
      (receiver.address() as import("node:net").AddressInfo).port;
    const hook = home + "/deliver.js";
    await writeFile(
      hook,
      `#!${process.execPath}\nimport {writeFile} from 'node:fs/promises';let text='';for await(const c of process.stdin)text+=c;const e=JSON.parse(text);if(e.agentID==='crash-delivery'){await writeFile(${JSON.stringify(home)}+'/hook.pid',String(process.pid));await fetch(${JSON.stringify(endpoint)},{method:'POST',body:JSON.stringify({runID:e.runID,text:'Completed report'})});}\n`,
      { mode: 0o700 },
    );
    await chmod(hook, 0o700);
    const model = {
      ...settings.qwen,
      compactionThresholdTokens: 2600,
      slotSnapshots: { enabled: false, directory: null },
    };
    const store = storeSchema.parse({
      version: 2,
      config: {
        revision: 1,
        host: "127.0.0.1",
        port: 8888,
        rootTokenHash: tokenHash(token),
        interactionCooldownMs: 0,
        models: [model],
        slots: [],
        hooks: [
          {
            event: "run.completed",
            purpose: "delivery",
            executablePath: hook,
            timeoutMs: 60000,
          },
        ],
        scheduler: {
          instantModelID: model.modelID,
          contextTokens: 8192,
          maxConcurrent: 1,
          minResidencyMs: 0,
          maxWaitMs: 1000,
          timersEnabled: false,
        },
      },
      agents: [],
      cooldownUntil: null,
    });
    await writeFile(home + "/config.json", JSON.stringify(store), {
      mode: 0o600,
    });
    const until = async (fn?: any, ms = 180000) => {
      const start = Date.now();
      while (Date.now() - start < ms) {
        const value = await fn();
        if (value) return value;
        await delay(100);
      }
      throw Error("Deadline exceeded");
    };
    const start = async () => {
      child = fork(
        new URL("./fixtures/crash-worker.ts", import.meta.url),
        [home],
        { stdio: ["ignore", "inherit", "inherit", "ipc"] },
      );
      port = null;
      child.on("message", (m: any) => {
        if (m.port) port = m.port;
        if (m.runtimePID) owned.add(m.runtimePID);
      });
      await until(() => {
        if (child.exitCode !== null) throw Error("Worker exited");
        return port;
      }, 30000);
    };
    const kill = async () => {
      const proc = child;
      const rows = execFileSync("ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .map((l) => l.trim().split(/\s+/).map(Number));
      const tree = new Set([proc.pid]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const [pid, parent] of rows)
          if (tree.has(parent) && !tree.has(pid)) {
            tree.add(pid);
            changed = true;
          }
      }
      for (const pid of tree) if (pid !== proc.pid) owned.add(pid);
      proc.kill("SIGKILL");
      await new Promise<any>((resolve) => proc.once("exit", resolve));
      child = null;
      await delay(1500);
      let hookPID;
      try {
        hookPID = Number(await readFile(home + "/hook.pid"));
      } catch {}
      const orphans = [...owned, ...(hookPID ? [hookPID] : [])].filter(alive);
      await record("process_crashed", {
        descendantsChecked: tree.size - 1,
        orphans,
      });
      assert.deepEqual(
        orphans,
        [],
        "llama.cpp must not remain alive after its owner crashes",
      );
    };
    const rpc = async (
      command: string,
      request = {},
      resourceID: string | undefined = undefined,
    ) => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/operations/${command.replaceAll(" ", "/")}`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ request, resourceID }),
        },
      );
      const value = await res.json();
      assert.equal(res.status, 200, JSON.stringify(value));
      return value;
    };
    const read = (id: string) =>
      readFile(`${home}/runs/${id}/state.json`, "utf8").then(JSON.parse);
    const complete = (id: string) =>
      until(async () => {
        const r = await read(id);
        if (r.held || ["failed", "timedOut", "cancelled"].includes(r.state))
          throw Error(
            JSON.stringify({ state: r.state, error: r.error, runID: id }),
          );
        return r.state === "completed" && r;
      });
    const message = (content: string) => ({
      messageID: randomUUID(),
      content,
      attachments: [],
    });
    const draft = (agentID: string, extra = {}) => ({
      agentID,
      name: agentID,
      systemPrompt:
        "Follow instructions. Preserve the project facts: code lavender, seven trees, blue gate.",
      modelID: model.modelID,
      mode: "single-turn",
      slotID: "auto",
      contextMode: "persistent",
      skillIDs: [],
      toolIDs: [],
      thinking: false,
      enabled: true,
      maxOutputTokens: 1024,
      timeoutMs: 300000,
      timeSliceMs: 300000,
      temperature: 0,
      ...extra,
    });
    t.after(async () => {
      if (child) {
        child.send("close");
        await Promise.race([
          new Promise<any>((r) => child.once("exit", r)),
          delay(10000),
        ]);
        if (child.exitCode === null) child.kill("SIGKILL");
      }
      for (const pid of owned)
        if (alive(pid)) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {}
        }
      receiver.closeAllConnections();
      await new Promise<any>((r) => receiver.close(r));
      await record("cleanup");
    });
    await record("started");
    await start();
    await rpc("agents create", { agent: draft("crash-generation") });
    const input = message("Write 12 numbered sentences about gardening.");
    const accepted = await rpc(
      "agents run",
      { message: input },
      "crash-generation",
    );
    await until(async () => {
      const r = await read(accepted.runID);
      return (
        r.state === "running" &&
        r.attempts.some(
          (a?: any) => a.status === "running" && a.text.length > 10,
        )
      );
    });
    await kill();
    await start();
    const generation = await complete(accepted.runID);
    assert.equal(
      generation.messages.filter((m?: any) => m.messageID === input.messageID)
        .length,
      1,
    );
    assert.ok(
      generation.attempts.some((a?: any) => a.status === "interrupted"),
    );
    assert.equal(
      generation.messages.filter(
        (m?: any) => m.role === "assistant" && !m.toolCalls.length,
      ).length,
      1,
    );
    await record("generation_resumed", {
      runID: accepted.runID,
      attempts: generation.attempts.map((a?: any) => a.status),
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
        agentID: "crash-summarizer",
        modelID: model.modelID,
        thinking: false,
        enabled: false,
        maxOutputTokens: 1536,
        timeoutMs: 300000,
      },
    });
    await rpc("agents create", {
      agent: draft("crash-compaction", {
        maxOutputTokens: 128,
        compaction: { handler: { type: "agent", agentID: "crash-summarizer" } },
      }),
    });
    let parent: any, compactor;
    for (let i = 0; i < 6; i++) {
      parent = await rpc(
        "agents run",
        {
          message: message(
            "Remember code lavender, seven trees, blue gate. Acknowledge briefly. Notes: " +
              "The garden path has shade and requires regular inspection. ".repeat(
                90,
              ),
          ),
        },
        "crash-compaction",
      );
      const state = await until(async () => {
        const r = await read(parent.runID);
        if (r.held) throw Error(JSON.stringify(r.error));
        if (r.compaction?.childRunID) {
          const c = await read(r.compaction.childRunID);
          if (
            c.state === "running" &&
            c.attempts.some((a?: any) => a.status === "running")
          )
            return { child: c };
        }
        return r.state === "completed" && { done: r };
      });
      if (state.child) {
        compactor = state.child;
        break;
      }
    }
    assert.ok(compactor, "Expected active compactor");
    await kill();
    await start();
    const compacted = await complete(parent.runID);
    const recovered = await read(compactor.runID);
    assert.equal(recovered.state, "completed");
    assert.ok(recovered.attempts.some((a?: any) => a.status === "interrupted"));
    assert.equal(
      compacted.compactions.filter(
        (c?: any) => c.childRunID === compactor.runID,
      ).length,
      1,
    );
    const recall = await rpc(
      "agents run",
      {
        message: message(
          "Return only the project code, tree count and gate color.",
        ),
      },
      "crash-compaction",
    );
    const answer = await complete(recall.runID);
    assert.match(answer.result, /lavender/i);
    assert.match(answer.result, /seven|7/i);
    assert.match(answer.result, /blue/i);
    await record("compaction_resumed", {
      runID: parent.runID,
      childRunID: compactor.runID,
      answer: answer.result,
    });
    await rpc("agents create", {
      agent: draft("crash-delivery", {
        contextMode: "fresh",
        maxOutputTokens: 32,
      }),
    });
    ambiguous = true;
    const delivery = await rpc(
      "agents run",
      { message: message("Say ready.") },
      "crash-delivery",
    );
    await until(() => received.length === 1);
    await kill();
    await start();
    const delivered = await read(delivery.runID);
    assert.equal(delivered.state, "completed");
    assert.ok(delivered.hookReceipts.some((h?: any) => h.status === "unknown"));
    await delay(2500);
    assert.equal(received.length, 1);
    await record("delivery_safely_held", {
      runID: delivery.runID,
      received: received.length,
    });
    await record("passed");
  },
);
