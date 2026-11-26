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

Thinking is disabled in this example. Live replay with the revised prompt advanced
the cursor correctly without thinking; enabling thinking still produced inaccurate
progress counts and conflated facts. Temperature remains 0.1 and the configured
output ceiling is 1536 tokens. The active timeout is three minutes.

Thinking is supported if enabled for an installation: give it enough generation
budget for both reasoning and the final answer. Linked compactor thinking is
limited to half that budget, capped at 1024 tokens, leaving room for a summary.
A larger budget does not establish factual correctness.

Linked compactors with thinking enabled retain their configured output budget.
Without thinking, the reservation is capped at the summary target plus 128 tokens.
The target accounts
for the parent’s retained context and tokenization slack, capped at 1024 tokens. The complete summarizer input must also fit: its system prompt, serialized
source messages, earlier summary, and reserved output all consume context. A parent
threshold close to a 4096-token slot's limit may leave too much input for this
summarizer. Compact earlier or configure more context. The handler request excludes stored thinking traces and base64 payloads; text
attachments are decoded and binary attachments are identified without guessing
their contents. JSON serialization can still expand the compactor input.
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

## Colocated evals

- `eval.json` is one saved eval definition; additional `eval-*.json` files are independent scenarios.
- Install this agent and its model/capabilities first. Evals keep its real finish contract and run through the ordinary scheduler.
- `grade.ts` checks the example's deterministic criteria; a passing check is not a general factual or semantic review.
- `eval.ts` resolves the optional TypeScript grader to absolute paths. It does not run inference.

```sh
node --experimental-strip-types examples/summarizer/eval.ts > /tmp/eval.json
nightcrew evals create --file /tmp/eval.json
nightcrew evals list
nightcrew evals run EVAL_ID --dry-run
# Explicit real-model evaluation:
nightcrew evals run EVAL_ID --wait
```

Pass another fixture file to `eval.ts` to install a different scenario. Inspect the returned run ID with `runs get` and `runs transcript`. See [the eval contract](../../docs/eval-format.md).
