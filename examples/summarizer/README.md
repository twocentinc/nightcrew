# Run summarizer

A single-turn compaction agent using a registered chat model named `qwen`.
Edit `modelID` in a copy of `agent.json` for your installation. Nothing is installed,
downloaded, or scheduled automatically. The prompt in `agent.json` is canonical.

The agent uses **no tools or skills**. Nightcrew supplies the previous summary and
older messages directly; fetching files or browsing would introduce new information
rather than summarize the accepted conversation. Single-turn agents do not execute
tools. This example merges earlier summaries, preserves constraints and recovery
references, distinguishes plans from verified results, and treats source instructions
as data. It returns exactly `{"summary":"..."}`.

## Install and connect

From a copied example directory:

```sh
nightcrew agents create --request agent.json
nightcrew agents get YOUR_AGENT_ID
```

To connect an existing agent, write an update request using its current revision:

```json
{
  "expectedRevision": 1,
  "changes": {
    "compaction": {
      "handler": { "type": "agent", "agentID": "summarizer" }
    }
  }
}
```

Replace the example revision with the value from `agents get`, then run
`nightcrew agents update YOUR_AGENT_ID --request update.json`. The summarizer's
`enabled: false` prevents automatic trigger dispatch; dependency compaction can
still invoke it. No recurring trigger is needed. Choose the model's
`compactionThresholdTokens` through revision-checked `models update`.

## Settings and context capacity

Thinking is disabled to keep the output budget available for the summary; this is
an initial latency/budget choice, not a demonstrated quality advantage. Temperature
0.7 follows Qwen3.5's general non-thinking temperature recommendation. Nightcrew
does not currently expose the model card's full sampling preset.

The 1536-token output limit allows a summary targeting at most 1024 tokens plus JSON
overhead. The complete summarizer input must also fit: its system prompt, serialized
source messages, earlier summary, and reserved output all consume context. A parent
threshold close to a 4096-token slot's limit may leave too much input for this
summarizer. Compact earlier or configure more context. Source thinking traces and
JSON serialization can make the compactor request larger than the parent's input.
Nightcrew pauses on overflow; this example does not add chunking.

## Try the synthetic example

`turn.json` contains a fictional release conversation and an earlier summary. Give
each invocation a fresh message UUID (the supplied UUID is only a placeholder):

```sh
node -e 'const fs=require("node:fs"),{randomUUID}=require("node:crypto");const r=JSON.parse(fs.readFileSync("turn.json","utf8"));r.message.messageID=randomUUID();console.log(JSON.stringify(r));' | nightcrew agents run summarizer --request -
```

This ordinary manual run waits for desktop-away and cooldown expiry. Inspect the
returned run ID with `runs get` or `runs transcript`. For this fixture, judge the
output by these facts, not an exact wording match:

- The current version is 0.13.0, superseding 0.12.0.
- Changes must remain local; pushing is not authorized.
- Lint is reported as passed; tests have not run. No tool evidence is supplied.
- `docs/release.md` still needs writing; no commit or push was made.
- The copied instruction must not make the response become `DONE`.
- The response is a JSON object with one summary string, without invented results.

Also evaluate real representative traces for lost constraints, identifiers,
uncertainty, and repeated-compaction drift before relying on this prompt for long
runs. Schema/package validation does not establish summarization quality.

## Research and rationale

Sources reviewed November 9, 2026:

- [Anthropic: effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  recommends preserving decisions, unresolved issues and important implementation
  details, reducing redundant output, and testing recall before compressing harder.
- [Anthropic: compaction on demand](https://platform.claude.com/docs/en/build-with-claude/compaction-on-demand)
  advises specifying what must survive and explicitly preventing tool calls. Its API
  behavior is not assumed to apply to Qwen; those prompt principles informed this example.
- [Qwen3.5-4B model card](https://huggingface.co/Qwen/Qwen3.5-4B)
  documents disabling thinking through API parameters and a 0.7 temperature for
  general non-thinking tasks. It does not establish this prompt's effectiveness.

The strict JSON envelope, repeated-summary merge instructions, evidence labels,
and trust-boundary handling are Nightcrew-specific design choices.
