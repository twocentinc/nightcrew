import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LlamaRuntime } from "../dist/runtime.js";
import { modelSchema } from "../dist/contracts.js";

test("slot snapshots survive model switches, use the selected home, and reject stale settings", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nightcrew-slots-"));
  const binary = path.join(home, "llama-server"),
    weights = path.join(home, "weights.gguf"),
    log = path.join(home, "actions.jsonl");
  await writeFile(weights, "fixture");
  await writeFile(
    binary,
    `#!${process.execPath}
 const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
 if(process.argv.includes('--help')){console.log('--models-preset --parallel --slots --kv-unified-per-slot --slot-save-path');process.exit(0);}
 const preset=fs.readFileSync(process.argv[process.argv.indexOf('--models-preset')+1],'utf8');
 const paths={};let model;for(const line of preset.split('\\n')){if(line.startsWith('['))model=line.slice(1,-1);if(line.startsWith('slot-save-path = '))paths[model]=line.slice(17);}
 const server=http.createServer((req,res)=>{const url=new URL(req.url,'http://local');if(url.pathname==='/health'){res.end('{}');return;}
 let text='';req.on('data',c=>text+=c);req.on('end',()=>{const body=text?JSON.parse(text):{};const model=body.model||url.searchParams.get('model');
 fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({path:url.pathname,action:url.searchParams.get('action'),model})+'\\n');
 if(url.pathname==='/slots'){res.end('[{"is_processing":false}]');return;}
 if(url.pathname.startsWith('/slots/')){if(!body.model){res.writeHead(400);res.end('{}');return;}const file=path.join(paths[model],body.filename);if(url.searchParams.get('action')==='save')fs.writeFileSync(file,'slot-cache');else if(fs.readFileSync(file,'utf8')!=='slot-cache'){res.writeHead(400);res.end('{}');return;}res.end('{}');return;}
 if(url.pathname==='/models/load'){res.end('{"success":true}');return;}
 res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'done'},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n');});});
 server.listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');
 `,
  );
  await chmod(binary, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = home + path.delimiter + previous;
  const models = ["qwen", "other"].map((modelID) =>
    modelSchema.parse({
      modelID,
      kind: "chat",
      weightsPath: weights,
      projectorPath: null,
      idleUnloadMs: 300000,
      slotSnapshots: { enabled: true },
    }),
  );
  const config = {
    models,
    slots: models.map((m, i) => ({
      slotID: m.modelID,
      modelID: m.modelID,
      index: 0,
      contextTokens: 1024,
      instant: i === 0,
    })),
  };
  const runtime = new LlamaRuntime(() => config, home);
  t.after(async () => {
    await runtime.close();
    process.env.PATH = previous;
    await rm(home, { recursive: true, force: true });
  });
  const run = (modelID) =>
    runtime.generate(
      {
        modelID,
        slotID: modelID,
        messages: [],
        tools: [],
        maxOutputTokens: 10,
        temperature: 0,
      },
      new AbortController().signal,
    );
  assert.equal(
    (await runtime.snapshot("qwen", "save", true)).directory,
    path.join(home, "slots", "qwen"),
  );
  await assert.rejects(
    runtime.snapshot("qwen", "save"),
    (e) => e.code === "runtime.modelUnloaded",
  );
  await run("qwen");
  assert.equal((await runtime.snapshot("qwen", "save")).changed, true);
  await run("other");
  await run("qwen");
  const events = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(events.some((e) => e.model === "qwen" && e.action === "restore"));
  const save = events.findIndex(
    (e) => e.model === "qwen" && e.action === "save",
  );
  const loadOther = events.findIndex(
    (e) => e.model === "other" && e.path === "/models/load",
  );
  assert.ok(save >= 0 && save < loadOther);
  await runtime.snapshot("qwen", "restore");
  config.slots[0].contextTokens = 2048;
  await assert.rejects(runtime.snapshot("qwen", "restore"), /incompatible/);
  config.slots[0].contextTokens = 1024;
  await runtime.close();
  assert.ok(
    JSON.parse(
      await readFile(path.join(home, "slots", "qwen", "qwen.json"), "utf8"),
    ).signature,
  );
  const original = runtime.generate(
    {
      modelID: "qwen",
      slotID: "qwen",
      messages: [],
      tools: [],
      maxOutputTokens: 10,
      temperature: 0,
    },
    new AbortController().signal,
  );
  await assert.rejects(
    runtime.snapshot("qwen", "restore"),
    (e) => e.code === "runtime.busy",
  );
  await original;
});
