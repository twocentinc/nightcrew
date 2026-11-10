# Hello world

Prerequisites: initialize Nightcrew, run its daemon, and register a chat model
and an instant slot. No model files are bundled or downloaded. Edit `modelID`
and `slotID` in a copy of `agent.json` to match `nightcrew models list` and
`nightcrew slots list`. The names `qwen` and `instant` are examples, not required
installation defaults. No skills or tools are needed.

```sh
nightcrew agents create --request agent.json
```

Creation refuses to overwrite an existing agent. Rename `agentID` or use the
existing revision-checked `agents update` command if you already have one.
`enabled: false` disables automatic dispatch, not manual invocation.

Generate a fresh message UUID for every new turn. For example, from this copied
example directory:

```sh
node -e 'const fs=require("node:fs"),{randomUUID}=require("node:crypto");const r=JSON.parse(fs.readFileSync("turn.json","utf8"));r.message.messageID=randomUUID();process.stdout.write(JSON.stringify(r));' | nightcrew agents run hello-world --request -
```

Use the returned run ID with `nightcrew runs get <runID>` or `nightcrew runs
transcript <runID>`. An instant-slot agent runs while the desktop is present and
during the interaction cooldown, preempting background runs after compute is
released. It extends the cooldown when finished. A background-slot agent waits
for desktop-away and cooldown expiry.

`turn.json` omits thinking and inherits the agent's false default.
`turn-thinking.json` sets it to true for just that turn. Before comparing thinking,
increase the agent's `maxOutputTokens` to 4096 through `agents update` with its
current `expectedRevision`; 32 tokens may truncate reasoning. Use the same limit
for both comparisons. Substitute `turn-thinking.json` in the command above, then
send `turn.json` again to exercise fallback. The override does not edit the agent.
The UUIDs in the sample files are placeholders; submitting them repeatedly tests
deduplication rather than starting fresh turns.
