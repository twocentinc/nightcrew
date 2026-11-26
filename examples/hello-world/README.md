# Hello world

Prerequisites: initialize Nightcrew, run its daemon, and register a chat model
with matching `modelID` in `agent.json`. No model files are bundled or downloaded. No skills or tools are needed.

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
transcript <runID>`. This background agent waits for desktop-away and cooldown
expiry. For interactive requests use `nightcrew instant create`; its model
defaults to `scheduler.instantModelID` and its slot is managed automatically.

`turn.json` omits thinking and inherits the agent's false default.
`turn-thinking.json` sets it to true for just that turn. Before comparing thinking,
increase the agent's `maxOutputTokens` to 4096 through `agents update` with its
current `expectedRevision`; 32 tokens may truncate reasoning. Use the same limit
for both comparisons. Substitute `turn-thinking.json` in the command above, then
send `turn.json` again to exercise fallback. The override does not edit the agent.
The UUIDs in the sample files are placeholders; submitting them repeatedly tests
deduplication rather than starting fresh turns.

## Colocated evals

- `eval.json` is one saved eval definition; additional `eval-*.json` files are independent scenarios.
- Install this agent and its model/capabilities first. Evals keep its real finish contract and run through the ordinary scheduler.
- `grade.ts` checks the example's deterministic criteria; a passing check is not a general factual or semantic review.
- `eval.ts` resolves the optional TypeScript grader to absolute paths. It does not run inference.

```sh
node --experimental-strip-types examples/hello-world/eval.ts > /tmp/eval.json
nightcrew evals create --file /tmp/eval.json
nightcrew evals list
nightcrew evals run EVAL_ID --dry-run
# Explicit real-model evaluation:
nightcrew evals run EVAL_ID --wait
```

Pass another fixture file to `eval.ts` to install a different scenario. Inspect the returned run ID with `runs get` and `runs transcript`. See [the eval contract](../../docs/eval-format.md).
