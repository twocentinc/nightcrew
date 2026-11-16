# Eval format v1

Implemented in Nightcrew 0.25.0. `src/evals.ts` owns validation and execution.

An eval suite supplies an agent with initial context, substitutes deterministic
responses for every tool, and records expectations separately from model-visible
input. The same loop supports tool-free summarization and multi-step agents.
The CLI exposes `evals validate` and `evals run`; protocol schema 29 adds
shared daemon sampling and release operations.

## Document structure

| Field                    | Meaning                                                                               |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `format`                 | Literal `nightcrew.eval`                                                              |
| `version`                | Eval document version, initially `1`                                                  |
| `suiteID`                | Stable suite identifier                                                               |
| `description`            | Human-facing purpose, not injected into context                                       |
| `agent.agentID`          | Installed agent to evaluate                                                           |
| `agent.expectedRevision` | Optional guard against testing an unintended revision                                 |
| `overrides.systemPrompt` | Optional complete prompt replacement for a candidate; never edits the installed agent |
| `limits.maxToolCalls`    | Finite call budget, including failed calls and skill loads                            |
| `limits.maxOutputTokens` | Per-generation output limit                                                           |
| `limits.timeoutMs`       | Finite active test runtime budget                                                     |
| `cases`                  | Nonempty collection of independent cases                                              |

Agent model, sampling, prompt, mode, and effective tool schemas are resolved and
snapshotted at run admission. Different candidates run against the same suite;
candidate overrides are recorded with the results. No unrestricted spread of
configuration overrides in v1. All state resets between cases. Run the suite again for independent repetitions.

Each case has `caseID`, optional description, `context.messages`, `mocks`, and
`expectations`. Context is ordered input, not hidden setup prose: every piece of
information the agent is supposed to use must appear there, in its snapshotted
prompt, or in a tool response. Objectives and expected answers are not silently
appended from the evaluator's metadata.

Reuse the semantic fields of `messageSchema` from `src/contracts.ts` for context
messages: role, content, attachments, tool calls, and tool-call linkage. The
authoring form may omit generated message IDs and empty arrays. Validate tool
history as complete linked exchanges, rather than allowing orphan tool results.
Case-level system messages are excluded in v1; candidate system prompt changes
belong in `overrides`. A tool-free case has no mocked calls and exposes no tools.

## Mock rules

Each rule has:

- `mockID`: unique within the case, also used by call-count assertions.
- `tool`: the model-visible function name.
- `arguments`: exact parsed JSON object expected from the model.
- `responses`: nonempty ordered list of outcomes for this argument match.
- `afterExhausted`: `fail` or `repeatLast`; default `fail`.

Match tool name and deep JSON equality after validating arguments against the
snapshotted tool schema. Object key order does not matter; array order does.
Absent fields differ from explicit null. Do not silently remove extra fields,
insert defaults, coerce types, or ignore a malformed arguments string. Duplicate
rules for the same tool/arguments are invalid; use a response sequence instead.

Rules are independently matchable: their array order does not impose a global
tool-call order. Each matching call consumes the next response from its rule.
This supports a first-call error followed by success without preventing valid
alternative exploration orders. Process calls in model-emitted order, serially
for v1, so response counters do not depend on wall-clock races.

An outcome is either:

- `{ "type": "result", "content": "exact model-visible tool text" }`
- `{ "type": "error", "message": "synthetic tool failure" }`

`result.content` is a string because tools can return JSON, plain text, or
Markdown. JSON-producing fixtures contain the serialized JSON that the model
would actually see. This avoids inventing a universal domain-output wrapper.
A successful tool returning a domain error inside its JSON is still a `result`;
`error` represents executor failure and uses the normal runtime error formatting.
Expected errors are delivered to the model and can be recovered from.

An unknown tool, unmatched arguments, malformed arguments, or exhausted rule is
a recorded fixture mismatch and ends that attempt. It never calls a real tool
or supplies fabricated success. Distinguish fixture mismatch from a completed
answer that failed a content expectation. For intentional retry tests, provide
the expected error in `responses` rather than relying on fixture mismatch.

## Skills and other runtime inputs

Snapshot the effective tool names, descriptions, and parameter schemas using
the existing model-visible function-tool contract. Do not copy executable paths
or argv into an eval fixture, and do not execute configured tools or hooks.
This interception includes built-ins such as `load_skills`, `runs_list`, and
`runs_transcript`. A case for an agent that loads skills needs matching
`load_skills` responses containing the intended skill text and reference content.
Installed skill names and descriptions are snapshotted for the catalog. Skill
instructions must come from mock responses; production transcripts are not read.

V1 runs fresh cases with compaction disabled. If a case exceeds the model's
context budget, report that explicitly. Compaction endurance should be a later
explicit capability, with its child-agent configuration and outputs captured,
rather than a hidden extra model affecting a basic answer-quality comparison.

## Expectations

Expectations are evaluator-only data and are never sent to the tested agent.
Keep deterministic assertions separate from semantic review criteria.

Deterministic v1 assertion kinds:

- `finalContains`: literal substring in the final answer.
- `finalNotContains`: literal substring absent from the final answer.
- `finalJSONSchema`: final answer is JSON satisfying the supplied schema.
- `mockCallCount`: a named mock was consumed between `min` and `max` times.

Each assertion has an `assertionID`. Literal assertions are case-sensitive;
they check text occurrence, not meaning. In particular, do not use absence of
the word "completed" to infer absence of a false completion claim.

Semantic criteria have `criterionID`, `description`, and `severity` (`critical`
or `normal`). The runner records criteria as `unreviewed`; it has no review-writing command.
Manual review should identify the reviewer and cite evidence alongside the bundle. A future
judge model must be an explicit, snapshotted reviewer and its findings must stay
distinguishable from deterministic checks. Unreviewed criteria never become an
overall pass. Reviewers must see the relevant context and tool trace as well as
the final answer, while treating all of it as data.

For Loose Threads, a semantic criterion might be: "Do not report Bob's task as
unresolved: message m-203 explicitly completes it." A call-count assertion can
separately verify that the agent actually requested the page containing m-203.

## Illustrative case fragment

This is a fragment, not a runnable suite: a complete Loose Threads case also
needs the skill-loading and overview fixtures, with the real reader's output
shape. Its page-call arguments below match the installed `discord_activity`
tool contract; the short result text is deliberately synthetic.

```json
{
  "caseID": "resolution-on-later-page",
  "context": {
    "messages": [
      {
        "role": "user",
        "content": "Find unresolved commitments in the supplied conversations."
      }
    ]
  },
  "mocks": [
    {
      "mockID": "first-page",
      "tool": "discord_activity",
      "arguments": { "action": "page", "page": 0 },
      "responses": [
        {
          "type": "result",
          "content": "m-101 Alice: I will send the draft.\nm-102 Bob: I will fix the link.\nnextPage: 1"
        }
      ],
      "afterExhausted": "repeatLast"
    },
    {
      "mockID": "resolution-page",
      "tool": "discord_activity",
      "arguments": { "action": "page", "page": 1 },
      "responses": [
        {
          "type": "result",
          "content": "m-203 Bob: The link is fixed and verified.\nnextPage: null"
        }
      ],
      "afterExhausted": "repeatLast"
    }
  ],
  "expectations": {
    "assertions": [
      {
        "assertionID": "read-resolution",
        "type": "mockCallCount",
        "mockID": "resolution-page",
        "min": 1,
        "max": 1
      }
    ],
    "criteria": [
      {
        "criterionID": "alice-open",
        "description": "Report Alice's draft as unresolved within the supplied window, citing m-101.",
        "severity": "normal"
      },
      {
        "criterionID": "bob-resolved",
        "description": "Do not report Bob's link task as open; m-203 resolves m-102.",
        "severity": "critical"
      }
    ]
  }
}
```

`repeatLast` makes a reread return the same data, while the call-count assertion
can still flag unnecessary repetition. For a transient-error case, the same
rule can instead contain an `error` followed by a `result`.

## Run artifacts, separate from input documents

A result bundle records suite and resolved-agent hashes, effective prompt/model/
sampling/limits, mock outcomes consumed, complete model/tool trace, final answer,
stop reason, tokens and timing, deterministic check results, and semantic reviews.
Fixture errors, context overflow, timeout, output truncation, and answer failures
remain distinct outcomes. Persist the exact inputs needed to reproduce a run.
Model inference can vary even with identical fixtures; comparisons should retain
individual repetitions rather than only an average score.

## Running a suite

Validate without a daemon or model:

```sh
nightcrew evals validate --request examples/evals/compaction-regressions.json
```

`evals run` takes a request object with `suite` (the complete document) and
`destination` (a new absolute directory whose parent already exists). For example,
prepare `/tmp/eval-request.json` with Node:

```sh
node --input-type=module -e 'import fs from "node:fs"; const suite = JSON.parse(fs.readFileSync("examples/evals/compaction-regressions.json", "utf8")); fs.writeFileSync("/tmp/eval-request.json", JSON.stringify({suite, destination: "/tmp/nightcrew-compaction-eval"}));'
nightcrew evals run --request /tmp/eval-request.json --dry-run
nightcrew evals run --request /tmp/eval-request.json --timeout 5m
```

Use the installation's `--home` when needed. The daemon must run the updated
version. Dry-run resolves and validates installed resources without inference or
creating the destination. Execution refuses to overwrite an existing directory.

V1 requires the agent model to match the configured instant model. Sampling uses
the daemon's instant scheduler and actual agent temperature, thinking and sampling
settings. Per-case limits are capped by agent limits; the CLI deadline also bounds
the whole suite. The snapshot includes model configuration, not weight-file hashes.
JSON output-validation schemas are included in the prompt. Production repair,
loop recovery, compaction, executable tools and hooks are disabled: this evaluates
the model's responses under a controlled loop, not all production orchestration.

`result.json` stores the resolved inputs, samples, trace, checks and errors. A CLI
`ok: true` means the command ran; inspect `result.status` for `passed`, `failed`,
or `needs_review`. Unreviewed semantic criteria prevent a pass even when all
literal checks pass. A failed assertion is distinct from a fixture mismatch or
inference error. Automatic fixture generation and automatic semantic grading are
not implemented.

The converted examples are documented in [examples/evals](../examples/evals/README.md).

The CLI suite deadline defaults to 120 minutes and accepts `--timeout` up to
`120m`; individual cases retain their own limits. Ordinary management commands
keep their 90-second default and five-minute maximum. Result schemas cover both
dry-run snapshots and completed suite summaries.
