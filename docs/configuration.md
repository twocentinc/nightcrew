# Understanding Nightcrew files

- A **model** points to local weights and defines context capacity.
- An **agent** chooses a model, instructions, skills, tools, and execution limits.
- A **run** records what happened when an agent worked. Nightcrew writes it for you.
- A **trigger** submits an agent turn manually or on a schedule.
- An **eval** submits an ordinary run with a starting transcript, mocked tool responses, and optional grading.

## Author definitions; let Nightcrew manage records

- Files such as `agent.json` in the examples are **CLI request files**. The outer `agent` key belongs to `agents create`; the object inside is the agent definition.
- Definitions do not need revisions, creation timestamps, run events, or storage versions. Nightcrew adds runtime metadata.
- Use `nightcrew schema get agents.create` to inspect accepted input, and `nightcrew schema get agents.create.result` for the response. They are different shapes.
- Use resource commands to edit definitions. Do not copy an entire `get` response into `create`, or hand-edit a run's `state.json`.
- Update requests carry the current `expectedRevision` or `expectedHash` to prevent overwriting concurrent changes.

A minimal agent request, after configuring a model named `local`:

```json
{
  "agent": {
    "agentID": "hello",
    "name": "Hello",
    "modelID": "local",
    "mode": "singleTurn",
    "systemPrompt": "Say hello briefly.",
    "skillIDs": [],
    "toolIDs": [],
    "enabled": true
  }
}
```

```sh
nightcrew agents create --request agent.json
```

- `singleTurn` produces one final response (which may require output-limit continuation); `agentLoop` can call tools and continue working.
- `contextMode: "fresh"` starts new runs; `persistent` continues one run across turns.
- `executionClass: "background"` follows presence/scheduler gates. `instant` gives eligible manual turns interactive priority on the instant model; timers and evals remain background work.
- `timeoutMs` limits total active work. `timeSliceMs` controls how long a background agent works before yielding. Paused time does not consume the active timeout.
- `maxOutputTokens` limits each model response; managed runs can continue truncated responses.

## Generation settings

```json
{
  "sampling": { "temperature": 0.7, "topP": 0.95 },
  "thinking": true,
  "parallelToolCalls": false
}
```

- Temperature and other token-sampling settings live together under `sampling`.
- `parallelToolCalls` controls tool calling, so it lives outside `sampling`.
- Agents, eval overrides, instant requests, and model tests share `sampling`. Model tests have no tools and do not accept `parallelToolCalls`. A model test defaults to temperature 0; agents and instant requests default to 0.7.
- Updating `sampling` replaces that object. Supply all nondefault sampling settings you want to retain.
- A user message can override `thinking` for its turn. Otherwise the agent default applies.

## Completion, checks, and delivery

- `finishSchema` is the agent's only structured-output JSON Schema. For chat agents it describes an object and enables the runtime-owned `finish` tool.
- With `finishSchema`, the agent must call `finish` alone. Ordinary text, malformed arguments, or schema mismatch ends the turn as `invalidOutput`; Nightcrew does not ask the model to repair it.
- Without `finishSchema`, ordinary final text completes the turn. Audio transcription uses this plain-output path.
- Eval `grader.schema` is a separate expectation, hidden from the evaluated model. When both schema and executable grading are configured, schema grading must pass first.
- `execution.state` describes agent execution: `queued`, `running`, `paused`, `completed`, `invalidOutput`, `failed`, `cancelled`, or `timedOut`.
- Delivery happens through hooks after execution. A delivery failure is recorded in hook events/receipts and reflected in `outcome.delivery`; it does not rewrite completed inference as failed.
- `outcome.output` reports configured validation, not factual correctness. `notChecked` means a finished turn has no stored validation evidence; historical runs are not revalidated. `needsAttention` and `reasons` flag issues. There is no second `task` state.
- `toolLoop` describes repeated-tool/error handling and forced finalization, not crash recovery.

## One executable shape

Tools, lifecycle hooks, scheduler hooks, compaction executables, and executable eval graders share:

```json
{
  "executablePath": "/absolute/path/to/program",
  "argv": ["--option", "value"],
  "timeoutMs": 10000
}
```

- Each `argv` item is one process argument. No shell expands it.
- Tools additionally allow `%parameter%` substitutions in individual arguments and always receive validated parameters as JSON on stdin.
- Other executable handlers receive their purpose-specific JSON input on stdin; their argv items are literal.
- The shared timeout range is 100–600000 ms. Defaults are 10000 ms, except scheduler hooks (2000 ms) and compaction executables (60000 ms).
- Compaction selects `{type: "agent", agentID}` or `{type: "exec", executablePath, argv, timeoutMs}`.
- Tool definitions add `toolID`, `description`, and an object JSON Schema named `parameters`.
- Eval mocks reference `toolID`; transcript function calls retain the model protocol's `name` and JSON-string `arguments`.
- Skill definitions contain instructions, tool IDs, and optional reference/assets files. Installed skills have `SKILL.md`; runs snapshot their contents so later edits do not change past evidence.

## Runtime files and versions

```text
~/.nightcrew/
  config.json              managed configuration, agents, models, triggers
  skills/<skillID>/        installed instructions and reference/assets files
  tools/<toolID>.json      executable tool definitions
  evals/<evalID>.json      managed eval definition and revision
  runs/<runID>/state.json  one atomic document containing messages and events
  backups/                original files retained by offline migrations
```

- Configuration disk format is **5**; run disk format is **10**. Normal readers accept only those current formats.
- Public command/API schema is **53**. It versions request and response contracts independently of disk layout.
- Protocol version **1** describes envelopes. Expanded run projections use version **4**, independent of the compact disk document. They are views, not files to write back into the run directory.
- Package version **0.53.1** identifies the software release.
- Historical evidence stays in run events and messages. Convenience fields in CLI/API responses are derived views, not extra copies of the underlying records.
- Before upgrading old files, stop the daemon and use the offline migration documented in [the spec](spec.md#run-records). It backs up originals and never replays tools or deliveries.

## Concise requests and responses

- Tool and skill updates use `{"expectedHash":"CURRENT_HASH","changes":{"description":"Updated description"}}`. The resource ID is the command operand. Omitted fields stay unchanged; explicit arrays replace the old arrays, including `[]` to clear them.
- Agent/model/trigger updates likewise use `changes`, with their existing revision checks.
- Message inputs need no empty `attachments`/`toolCalls` arrays or null `toolCallID`. User messages may attach files; assistant messages may call tools; tool results must supply a toolCallID.
- `agents list` returns identity, name, revision, model, mode, execution class, context mode, enabled state and update time. `tools list` returns toolID, description, hash and builtin. Use `get` for full definitions.
- Model mutations return `item`, `revision`, `changed` and `restartRequired`. A deletion returns a null item. Use `config get` for full configuration.
