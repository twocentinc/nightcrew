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

test("named KV contexts move between concurrent live slots and respect the disk budget", async (t) => {
  const home = await mkdtemp(path.join(tmpdir(), "nc-contexts-"));
  const binary = path.join(home, "llama-server"),
    weights = path.join(home, "weights"),
    log = path.join(home, "events");
  await writeFile(weights, "fixture");
  await writeFile(
    binary,
    `#!${process.execPath}
 const fs=require('node:fs'),http=require('node:http'),path=require('node:path');
 if(process.argv.includes('--help')){console.log('--models-preset --parallel --slots --kv-unified-per-slot --slot-save-path');process.exit(0);}
 const preset=fs.readFileSync(process.argv[process.argv.indexOf('--models-preset')+1],'utf8');
 const dir=preset.split('\\n').find(x=>x.startsWith('slot-save-path = ')).slice(17);const busy=[false,false,false];
 http.createServer((req,res)=>{const url=new URL(req.url,'http://local');let text='';req.on('data',c=>text+=c);req.on('end',()=>{const body=text?JSON.parse(text):{};
 if(url.pathname==='/health'||url.pathname==='/models/load'){res.end('{}');return;}
 if(url.pathname==='/apply-template'&&body.messages.some(m=>m.content==='template-error')){res.writeHead(500);res.end(JSON.stringify({error:{message:'System message must be at the beginning.'}}));return;}
 if(url.pathname==='/tokenize'&&body.content.includes('tokenize-error')){res.writeHead(422);res.end(JSON.stringify({error:{message:'Invalid tokenization request'}}));return;}
 if(url.pathname==='/apply-template'){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({template:body})+'\\n');res.end(JSON.stringify({prompt:JSON.stringify(body)}));return;}
 if(url.pathname==='/tokenize'){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tokenize:body})+'\\n');res.end(JSON.stringify({tokens:[1,2,3,4]}));return;}
 if(url.pathname==='/slots'){res.end(JSON.stringify(busy.map((is_processing,id)=>({id,is_processing}))));return;}
 if(url.pathname.startsWith('/slots/')){fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({slot:url.pathname,action:url.searchParams.get('action'),filename:body.filename})+'\\n');if(url.searchParams.get('action')==='save')fs.writeFileSync(path.join(dir,body.filename),'cache');res.end('{}');return;}
 const id=body.id_slot;busy[id]=true;fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({start:id,concurrent:busy.filter(Boolean).length})+'\\n');res.on('close',()=>busy[id]=false);
 setTimeout(()=>{busy[id]=false;res.setHeader('Content-Type','text/event-stream');res.end('data: '+JSON.stringify({choices:[{index:0,delta:{content:'done'},finish_reason:'stop'}]})+'\\n\\ndata: [DONE]\\n\\n');},100);
 });}).listen(Number(process.argv[process.argv.indexOf('--port')+1]),'127.0.0.1');
 `,
  );
  await chmod(binary, 0o700);
  const previous = process.env.PATH;
  process.env.PATH = home + path.delimiter + previous;
  const { schedulerSchema } = await import("../dist/scheduler.js");
  const config = {
    scheduler: schedulerSchema.parse({ snapshotBudgetMB: 1 }),
    models: [
      modelSchema.parse({
        modelID: "q",
        kind: "chat",
        weightsPath: weights,
        projectorPath: null,
        idleUnloadMs: 300000,
        slotSnapshots: { enabled: true },
      }),
    ],
    slots: [0, 1, 2].map((index) => ({
      slotID: "s" + index,
      modelID: "q",
      index,
      instant: index === 0,
      contextTokens: 1024,
    })),
  };
  const runtime = new LlamaRuntime(() => config, home);
  t.after(async () => {
    await runtime.close();
    process.env.PATH = previous;
    await rm(home, { recursive: true, force: true });
  });
  const generate = (
    slotID,
    contextID,
    persistContext = true,
    contextEpoch = 0,
  ) =>
    runtime.generate(
      {
        modelID: "q",
        slotID,
        contextID,
        persistContext,
        contextEpoch,
        messages: [],
        tools: [],
        maxOutputTokens: 10,
        temperature: 0,
      },
      new AbortController().signal,
    );
  const input = {
    modelID: "q",
    slotID: "s1",
    messages: [
      {
        messageID: "test",
        role: "user",
        content: "hello",
        attachments: [
          {
            name: "note",
            mediaType: "text/plain",
            dataBase64: Buffer.from("attachment").toString("base64"),
          },
        ],
        toolCalls: [],
        toolCallID: null,
      },
    ],
    tools: [
      { name: "inspect", description: "read", parameters: { type: "object" } },
    ],
    thinking: true,
    maxOutputTokens: 10,
    temperature: 0,
  };
  assert.equal(
    await runtime.countTokens(input, new AbortController().signal),
    4,
  );
  const counted = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(counted[0].template.messages[0].content.includes("attachment"));
  assert.equal(counted[0].template.tools[0].function.name, "inspect");
  assert.equal(counted[0].template.chat_template_kwargs.enable_thinking, true);
  assert.equal(counted[1].tokenize.parse_special, true);
  for (const [content, endpoint, status] of [
    ["template-error", "/apply-template", 500],
    ["tokenize-error", "/tokenize", 422],
  ]) {
    await assert.rejects(
      runtime.countTokens(
        {
          ...input,
          messages: [{ ...input.messages[0], content, attachments: [] }],
        },
        new AbortController().signal,
      ),
      (error) =>
        error.name === "ContextPreparationError" &&
        error.message.includes(endpoint) &&
        error.message.includes(`HTTP ${status}`) &&
        error.message.includes(
          content === "template-error"
            ? "System message must be at the beginning"
            : "Invalid tokenization request",
        ),
    );
  }

  await Promise.all([generate("s1", "alpha"), generate("s2", "beta")]);
  assert.ok((await readFile(log, "utf8")).includes('"concurrent":2'));
  assert.ok(
    JSON.parse(
      await readFile(path.join(home, "slots/q/alpha.json"), "utf8"),
    ).filename.startsWith("alpha-"),
  );
  await generate("s2", "alpha");
  const entries = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert.ok(
    entries.some(
      (e) =>
        e.slot === "/slots/2" &&
        e.action === "restore" &&
        e.filename.startsWith("alpha-"),
    ),
  );
  assert.equal((await runtime.contextCache("alpha", false)).items.length, 1);
  const alphaBefore = await readFile(
    path.join(home, "slots/q/alpha.json"),
    "utf8",
  );
  await generate("s2", "run-fresh-one", false);
  await generate("s2", "run-fresh-one", false);
  await generate("s2", "run-fresh-two", false);
  const takeover = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .slice(entries.length);
  assert.deepEqual(
    takeover.filter((e) => e.action).map((e) => e.action),
    ["erase", "erase"],
  );
  assert.equal(takeover.filter((e) => e.start === 2).length, 3);
  assert.equal(
    await readFile(path.join(home, "slots/q/alpha.json"), "utf8"),
    alphaBefore,
  );
  assert.equal(
    (await runtime.contextCache("run-fresh-one", false)).items.length,
    0,
  );
  await generate("s2", "alpha");
  const resumed = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .slice(entries.length + takeover.length);
  assert.deepEqual(
    resumed.filter((e) => e.action).map((e) => e.action),
    ["erase", "restore", "save"],
  );

  const beforeEpoch = (await readFile(log, "utf8")).trim().split("\n").length;
  await generate("s2", "alpha", true, 1);
  const epochEvents = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .slice(beforeEpoch);
  assert.deepEqual(
    epochEvents.filter((e) => e.action).map((e) => e.action),
    ["erase", "save"],
  );
  await generate("s1", "alpha", true, 1);
  const epochRestore = (await readFile(log, "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse)
    .slice(beforeEpoch + epochEvents.length);
  assert.deepEqual(
    epochRestore.filter((e) => e.action).map((e) => e.action),
    ["erase", "restore", "save"],
  );
  config.scheduler.snapshotBudgetMB = 0;
  await runtime.pruneSnapshots();
  assert.equal((await runtime.contextCache("alpha", false)).items.length, 0);
});
