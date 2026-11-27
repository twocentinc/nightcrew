# Evals

- An eval is an ordinary Nightcrew run with a saved starting transcript, substituted tool responses, and optional grading.
- The agent's configured model, system prompt, `finishSchema`, tool loop, output continuation, scheduler, timeouts, interruption recovery, and compaction remain in use. No instant model is required.
- Each invocation creates a separate run, including for persistent agents. Eval caches do not overwrite the persistent agent cache.
- The eval definition and revision are snapshotted at admission and exposed as `evaluation` in expanded run views. The on-disk run stores this evidence in events. Later edits affect new runs only.
- Ordinary tool calls (including `load_skills`) use only the eval's responses. Unmatched/invalid calls return ordinary tool errors; they never execute a production tool. The runtime-owned `finish` tool cannot be mocked.
- Production lifecycle/delivery hooks are suppressed. Compaction handlers still run normally. An executable grader is an explicitly trusted program with the daemon user's permissions, not a sandbox.

## Definition

```json
{
  "evalID": "record-answer",
  "agentID": "researcher",
  "overrides": { "modelID": "qwen-9b", "thinking": true },
  "messages": [
    { "role": "user", "content": "Read record 42 and report its status." }
  ],
  "tools": [
    { "toolID": "read_record", "output": { "error": "not found" } },
    {
      "toolID": "read_record",
      "input": { "id": 42 },
      "output": { "status": "ready" }
    }
  ],
  "grader": {
    "schema": {
      "type": "object",
      "properties": { "status": { "const": "ready" } },
      "required": ["status"]
    }
  }
}
```

- `evalID` and `agentID` are required. Definitions are stored as `{revision, definition}` in `~/.nightcrew/evals/<evalID>.json` (or the selected home).
- Optional `overrides`: `modelID`, `systemPrompt`, `thinking`, `sampling`, `parallelToolCalls`, `maxOutputTokens`, `maxToolCalls`, `timeoutMs`. Omitted fields retain agent settings. Temperature belongs inside `sampling`; supplying `sampling` replaces that object rather than merging individual settings. The scheduler assigns a slot for the selected model; agents do not own fixed physical slots.
- Overrides cannot replace `finishSchema`, or configured tools/skills. The eval tests those real contracts.
- `messages` defaults to `[]`; at least one user message is required to run. Roles are `user`, `assistant`, `tool`. The agent supplies the system message. Message UUIDs can be omitted during authoring; Nightcrew assigns them. Each run gets fresh message UUIDs.
- Messages support ordinary `thinking`, `reasoningContent`, `attachments`, `toolCalls`, and `toolCallID` fields. Tool calls retain their call IDs for pairing. Only user messages carry attachments; only assistants call tools. Tool results must follow their calls. An unfinished tool exchange may appear only at the end and resumes through the normal tool loop. A seeded `finish` call must already have its result; it cannot complete the new eval without model generation.
- A seeded assistant answer is context, not the new run's final answer. Historical tool calls still contribute to the ordinary conversation's loop/tool budget checks.
- `tools` defaults to `[]`. A rule with `input` matches exact JSON structure (object key order is irrelevant; array order matters). Omitting `input` supplies the fallback for that tool. Exact matches win. Duplicate matches are rejected. `output` can be any JSON value up to 1 MB; strings are returned verbatim, other values are JSON-encoded. To simulate errors, supply the tool's normal error-shaped output.
- `grader` can be omitted or `null` for no grading. Expected schemas and executable details are never added to model context or supplied as repair feedback.

## Grading

Invalid finish calls or rejected final answers terminate execution immediately; neither normal validation nor grading asks the model to repair its answer.

1. The ordinary run must complete and satisfy its own finishSchema when configured. Execution/validation failures cannot pass an eval.
2. If `grader.schema` exists, validate the **accepted finish arguments** using the existing Zod `z.fromJSONSchema` validator. For an agent without `finishSchema`, validate its final answer as a string. Nothing rewrites the real agent schema or changes the accepted output.
3. A schema mismatch fails grading and skips the executable.
4. If `grader.exec` exists, execute it after schema success (or directly when no grading schema is configured).
5. With neither grader configured, a successful run is `ungraded`.

```json
{
  "schema": { "type": "object", "required": ["report"] },
  "exec": {
    "executablePath": "/absolute/path/to/node",
    "argv": ["--experimental-strip-types", "/absolute/path/to/grade.ts"],
    "timeoutMs": 10000,
    "sourceFiles": []
  }
}
```

- Executable stdin is one JSON object: `{eval, run, result}`. `run` is the expanded version-4 run projection produced by `encodeRun`, including `messages`, `attempts`, and `evaluation`. It is not the compact format-10 `state.json` document; graders should read the projection fields rather than decode storage events. `result` is the accepted finish value (or final text for agents without a finish schema).
- Stdout must contain exactly `{ "passed": true, "reason": "Explanation" }` (or `passed: false`). A nonzero exit, malformed output, changed source, timeout, or process failure records grading `error`.
- `timeoutMs` defaults to 10000 ms and accepts 100–600000 ms, using the shared executable schema. Grader input is bounded to 64 MB and output to 1 MB.
- The executable, existing file arguments, and optional additional `sourceFiles` are hashed at admission and checked before execution. Declare imported source/data files when their identity matters. The captured daemon working directory is used at execution.
- The latest grade is exposed in `evaluation.grade` in expanded run views; each settled grade is also recorded as an `evalGraded` event. Execution status and grading status are separate: a completed run may fail grading.
- A daemon restart can grade a terminal run that has not started grading. An interrupted grader is marked `error` with an unknown-outcome explanation and is never automatically replayed.
- Checks establish only what they test. Schema conformance or literal presence does not establish factual accuracy. An executable can perform richer deterministic checks or invoke a separate reviewer; Nightcrew does not provide a built-in judge model.

## CLI

```sh
nightcrew evals create --file eval.json
nightcrew evals list
nightcrew evals get record-answer
nightcrew evals update record-answer --request changes.json
nightcrew evals run record-answer --dry-run
nightcrew evals run record-answer --wait
nightcrew runs get RUN_ID
nightcrew runs transcript RUN_ID
nightcrew evals delete record-answer --yes
```

- `evals run` submits immediately; it does not wait for the scheduler by default. `--wait` observes ordinary completion and grading without cancelling the run on disconnection. A completed execution with failed grading is returned with that grade; inspect `evaluation.grade.status`.
- Presence, interaction cooldown, queue holds, and model residency policies apply. Use ordinary `runs` controls for inspection and recovery.
- Updates use `{ "expectedRevision": 1, "changes": { "overrides": { "thinking": false } } }`. Revision checks are optional. Specified fields replace those fields; omitted fields remain unchanged. Use `grader: null`, `tools: []`, or `messages: []` to clear them.
- Replies/retries reuse the eval snapshot and grade each new turn; wait for grading to settle before reopening a terminal run. Historical verdicts remain in events.
- Delete removes only the definition; previous runs retain their snapshots.

```sh
nightcrew evals tools list record-answer
nightcrew evals tools set record-answer --tool read_record --output fallback.json
nightcrew evals tools set record-answer --tool read_record --input input.json --output response.json
nightcrew evals tools delete record-answer --tool read_record --input input.json
nightcrew evals tools delete record-answer --tool read_record

nightcrew evals transcript get record-answer
nightcrew evals transcript set record-answer --file messages.json
nightcrew evals transcript append record-answer --file message.json
nightcrew evals transcript update record-answer MESSAGE_UUID --file message.json
nightcrew evals transcript delete record-answer MESSAGE_UUID
printf '{"messages":[]}\n' | nightcrew evals transcript set record-answer --request -
```

- `--file`, `--input`, and `--output` read JSON; `-` reads stdin. Only one input can read stdin. String outputs must be JSON strings in their files.
- Transcript set/append accept one message or an array through `--file`. Update accepts one message and preserves its UUID. Delete cascades an assistant message's paired tool results. Invalid pairing is rejected atomically.
- `--message MESSAGE_UUID` is also available for update/delete. Flags and `--request` cannot specify the same field twice.
- CLI shortcuts assemble the same typed oRPC requests used by HTTP/control clients. All `evals` operations are public management operations; there is no private instant sampling API.

`src/engine/evals/format.ts` owns the schema; `definitions.ts` owns edits and override validation, `tools.ts` mock matching, and `results.ts` grading. `src/storage/evals.ts` owns definition files using the shared storage transaction queue. The ordinary run engine owns execution. Examples and their TypeScript graders live beside each example agent.
