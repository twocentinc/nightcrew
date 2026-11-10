# Nightcrew

Standalone local-agent daemon and JSON-first CLI. Nightcrew owns its HTTP server,
local control socket, llama.cpp processes, scheduling and run transcripts.
It has no the client application or Guildscribe runtime dependency.

## Build and discover

Requires Node 22.12+ and a compatible `llama-server` on PATH.

```sh
npm ci
npm run build
./bin/nightcrew help
./bin/nightcrew schema get models.create
npm run lint
npm test
```

The package exposes a `nightcrew` executable. `src/management.ts` owns the command
catalog and request schemas. `help` and `schema get <resource.action>` work before
initialization. Every finite command emits one JSON envelope; diagnostics go to
stderr. Unknown options are rejected. Use `--request <file|->` for JSON inputs,
`--request-id`, `--home <absolute-path>`, and `--timeout 30s` as needed.
`--no-input` and `--non-interactive` are supported; commands never prompt.

## Initialize and manage the daemon

The default home is `~/.nightcrew`; `--home` overrides `NIGHTCREW_HOME`.
Source and runtime data remain separate.

```sh
nightcrew init
nightcrew doctor
nightcrew startup install --dry-run
nightcrew startup install
nightcrew startup status
nightcrew daemon status
nightcrew startup logs --lines 100
nightcrew startup stop
nightcrew startup start
nightcrew startup restart
nightcrew startup uninstall --yes
```

`init` defaults to loopback port 6970, a five-minute interaction cooldown, and
empty agent/model registries. It refuses to overwrite configuration and returns
the HTTP root token once. Keep that value in your client’s secret storage.
`auth rotate --yes` replaces the HTTP token and returns a new one once; it does
not require the old token because local management is protected by filesystem
ownership. Tokens never appear in the plist or daemon logs. `init --request`
accepts settings from the exported initialization schema.

`daemon run` starts in the foreground; SIGINT/SIGTERM shuts down gracefully.
`daemon stop` stops a foreground daemon or its selected installed LaunchAgent.
Startup management uses the per-user `dev.nightcrew.daemon` LaunchAgent. Stop
unloads the service so launchd cannot immediately relaunch it; start reloads it.
Uninstall removes registration only. Conflicting registrations are refused.
The plist records absolute Node/CLI paths and an explicit PATH, without shell
initialization. Logs live under `<home>/logs`.

## Configure resources

Agents, models, skills and tools each provide `list`, `get <ID>`, `create`,
`update <ID>` and `delete <ID>`. Structured writes use `--request`; deletes also
require `--yes`. Mutations support `--dry-run`.

```sh
nightcrew config get
nightcrew schema get config.update
nightcrew agents list
nightcrew schema get agents.create
nightcrew models list
nightcrew schema get models.create
nightcrew skills list
nightcrew tools list
```

Agent updates use the agent’s `expectedRevision`. Config/model updates use
configuration `expectedRevision`. Skill/tool reads include a content `hash`;
updates/deletes require `expectedHash`. Model creation accepts its model and
legacy slots for compatibility; new configurations derive slots from scheduler settings. Set `scheduler.instantModelID` to the chat model serving interactive requests. Referenced resources cannot be deleted; remove their
references first. No command downloads models or deletes model weights.

Edits go through `<home>/control.sock` while the daemon runs. The socket and home
are owner-only. With the daemon stopped, configuration commands acquire its
exclusive storage lock before editing. Model/slot/settings changes are rejected
while work is nonterminal; changing HTTP bind settings reports `restartRequired`.
Agent edits affect future runs. Skills and tool definitions are snapshotted in
new runs; historical runs retain their configuration.

`agents enable` / `disable` update eligibility. `agents run`, `runs list`,
`runs get`, `runs transcript`, `runs reply` and `runs cancel` operate through a
running daemon. Enabled interval and cron triggers dispatch automatically.

## Skills and tools

Skills use folders rooted at `<home>/skills/<skillID>/SKILL.md`, with optional
`references/` and `assets/` trees. The CLI accepts metadata, instructions and
resource files. See “On-demand skill folders” below.
Custom tools use `<home>/tools/<toolID>.json`.

Bundled tools are immutable: `load_skills`, `runs_list`, and
`runs_transcript`. They are ordinary executable tools. History tools call the CLI;
load_skills reads selected skill snapshots supplied over a private process pipe. Every tool requires an absolute `executablePath`, an object JSON Schema in
`parameters`. There are no adapter or readOnly fields.
See `schema get tools.create` for the full shape.

`argv` is the process argument template list (strings, default empty).
The model's arguments are separate JSON sent on stdin: numbers, booleans, arrays,
nested objects and strings are supported according to `parameters`.
Nightcrew validates that input, executes without a shell, and expects JSON on
stdout. Output is limited to 1 MB; timeout and interruption terminate the owned
process group. `timeoutMs` defaults to 10000, with a 100–60000 range.

Tools receive PATH and the non-secret context variables NIGHTCREW_HOME,
NIGHTCREW_AGENT_ID and NIGHTCREW_RUN_ID. The skills helper additionally receives its
selected snapshots over file descriptor 3 (NIGHTCREW_SKILLS_FD). They do not
inherit the daemon's secret environment or root token. These identities are convenience context, not access
credentials. Bundled wrappers retain same-agent history and selected-skill checks;
a trusted custom executable has the local user's permissions. Nightcrew does not
enforce read-only behavior or provide an OS sandbox.

Historical adapter-based JSON files and run snapshots are converted in memory
when read, including removal of readOnly and conversion of arguments to argv;
new create/update requests reject these legacy fields. The files are not silently
rewritten. `runs list`, `runs get` and `runs transcript` also support read-only
offline inspection, allowing wrappers to use the CLI without starting inference.

## HTTP and storage

`GET /openapi.json` describes the REST API generated from oRPC procedures. Health
and OpenAPI are public; `/v1/*` requires the shared root bearer token. There is
no separate RPC transport. The owner-only local control socket is for the CLI,
not remote clients.

Configuration is `config.json`; each run owns `runs/<runID>/state.json`.
New run records use version 2 with tool snapshots; version 1 records remain
readable and move to version 2 on their next write. Text and files belong to
individual UUID-identified messages. Interactive chat state is memory-only and
expires 15 minutes after termination.

Managed runs require healthy desktop-away detection and an expired interaction
cooldown. Presence sampling uses macOS lock, console-user and idle information.
Instant requests interrupt background generation and wait for confirmed compute
release before running. Paused time does not consume the agent timeout. SSE
replays committed events and streams provisional text; disconnect does not
cancel accepted inference. Hooks record attempts before execution and do not
retry interrupted attempts.

Tests use temporary homes, fake executables and isolated listeners. The [model-switch verification](docs/model-switch-verification.md) records a
successful Qwen → Granite → Qwen test, including disk slot restoration.
Cancellation and broader workloads still need verification before migrating the chat client.

## Supervisor command contract

`help [scope]` (for example, `help models` or `models create --help`) is generated
from the same command definitions used by parsing and dispatch. `schema get
models.create` returns the request schema; use `models.create.result` for its
result. `version` reports package, protocol and schema versions separately.

Finite commands emit exactly one JSON envelope on stdout, including errors.
Use `--request-id <ID>` to correlate a command with supervisor work. Errors have
`code`, `message`, `details`, `exitCode`, and `retrySafety`: `safe` means replay
has no ambiguous mutation, `unsafe` means inspect state before retrying, and
`never` means change the request or resolve the reported condition first.
A timed-out mutation can have an unknown outcome; never blindly retry it.

| Exit | Class                                 |
| ---- | ------------------------------------- |
| 0    | Success                               |
| 1    | Internal failure or invalid result    |
| 2    | Invalid command, request or options   |
| 3    | Configuration, permissions or storage |
| 4    | Unsupported platform                  |
| 5    | Runtime dependency unavailable        |
| 6    | Deadline exceeded                     |
| 7    | Resource or daemon unavailable        |
| 8    | Explicit confirmation required        |
| 9    | Revision or resource conflict         |

`--timeout 90s` is the default finite-command deadline; durations accept `ms`,
`s`, or `m`, up to five minutes. It covers input, local work, IPC, child processes
and startup readiness polling. Accepted background runs use their own agent
timeouts and continue independently. Foreground `daemon run` lasts until stopped.
`--verbose` and `--verbosity debug` emit structured diagnostics on stderr;
`--quiet` suppresses them. `--no-input` / `--non-interactive` explicitly select
the CLI's always noninteractive behavior. Required confirmations still use
`--yes`; neither flag authorizes destructive changes.

`capabilities` reports configured model adapter support and tool trust boundaries.
It explicitly marks model-specific inference and interruption as unverified.
`doctor` checks configuration, references, file availability, executables and
presence. `doctor --live` additionally checks the existing daemon's PID and status
freshness and reports agent eligibility blockers. Diagnostics never provision a
model or start the daemon. Inspect `healthy` and individual checks in the result;
a completed diagnostic may successfully report an unhealthy system.

Presence has two read-only commands:

```sh
nightcrew presence status
nightcrew presence sample
```

`presence status` reads the running daemon's latest sample and `cooldownUntil`;
it fails if the daemon is unavailable. `presence sample` takes a fresh reading
of the local desktop without requiring an initialized home or running daemon.
It does not update the daemon's sample or change scheduling. Both expose
`state`, `reason`, `samplingHealthy`, `observedAt`, and `diagnostic` (nested under
`presence` for status). An unhealthy sample conservatively reports `present`;
check `samplingHealthy`, not just the command's success envelope.

On macOS, a locked session, switched-out user, or ten minutes without input
counts as away. The daemon normally samples every five seconds. Desktop
presence and the interaction cooldown are separate gates for background work;
being away does not bypass an active cooldown. Other platforms report unhealthy
presence. These commands do not load models or override presence detection.

Command and JSON Schema snapshots live under `test/snapshots`. `npm run
contracts:check` rejects drift. When intentionally changing the contract,
increment `SCHEMA_VERSION` in `src/protocol.ts`, then run `npm run
contracts:update`; old version archives must remain unchanged. Package versions
are independent. `npm test` checks the contracts and integration behavior.
`npm run test:package` packs the allowlisted distribution, independently installs
it in a temporary directory, and exercises the installed executable with an
isolated runtime home. It uses npm's cache, fetching locked dependencies if needed.

## Slot snapshots

Models optionally enable disk-backed prompt caches:

```json
"slotSnapshots": {
  "enabled": true,
  "directory": null
}
```

The default directory is `<home>/slots/<modelID>` (`~/.nightcrew/slots/qwen`
for Qwen with the default home). An absolute `directory` overrides the base;
Nightcrew appends the model ID to keep models separate. Existing models default
to snapshots disabled. Set this object through `models create` or the `changes`
object of a revision-checked `models update` request.

Use `agents cache AGENT_ID` to inspect persistent caches and
`agents reset-cache AGENT_ID --yes` to discard them without deleting the transcript.
Physical slots are internal scheduler allocations; slot CRUD/save/restore commands
are no longer exposed. Snapshots use unique files and atomic manifests.

When enabled, Nightcrew saves slots before a model switch, idle unload, or clean
shutdown, and attempts restoration when the model next loads. It stops the old
owned router before starting the next model, keeping one model resident. Saves
require idle model slots. Forced termination may lose the latest cache.
Automatic save/restore failures emit diagnostic events; missing or incompatible
snapshots fall back to processing the supplied conversation. Explicit commands
report failures. Transcript state remains authoritative.

Compatibility fingerprints include model/projector and executable file identity,
size and timestamps, plus model settings and slot layout. They intentionally
invalidate conservatively and are not cryptographic hashes of model weights.
Caches are private, disposable acceleration, not portable conversation backups.
Fake-server tests cover the lifecycle. A real short-text snapshot round trip and
synthetic Granite transcription passed; see the model-switch verification report
for timings and the remaining limits.

Agents also configure `thinking` (default `true`) and `maxOutputTokens` (default
4096, range 1–32768). Set `thinking: false` and a small output limit for simple
checks; Nightcrew forwards this as `chat_template_kwargs.enable_thinking` to
llama.cpp. Thinking support depends on the model's chat template. These settings
are snapshotted per run, so edits apply to new runs. Existing agents and saved
runs receive the legacy defaults when these fields are absent.

For a single turn, include optional `thinking` inside its submitted `message`:

```json
{
  "message": {
    "messageID": "ed98a13e-a364-41db-b5c8-47cb4b69a12c",
    "content": "Explain this carefully.",
    "attachments": [],
    "thinking": true
  }
}
```

Use this request with `agents run <agentID>` or `runs reply <runID>` (generate a
fresh message UUID for each new turn). Omit `thinking` to use the run's snapshotted
agent default; `false` explicitly disables thinking. An override lasts for that
user turn, including its tool loop, and does not carry over to the next reply or
edit the agent. The override is persisted with the message and participates in
UUID deduplication: changing it while reusing the UUID is a conflict. Interactive
chat submissions also honor the latest user message's override; without an agent
default, omission leaves thinking to the model's template default.

## Bundled examples and instant agents

The packaged [examples directory](examples/README.md) contains ordinary request
files and instructions. It is never automatically installed by `init`; there
are no example-specific commands. Copy files and customize them through the
existing CRUD commands. Hello world is disabled for recurring dispatch but
remains manually runnable.

Explicitly submitted agents assigned to the instant slot bypass desktop presence
and interaction cooldown checks. They preempt background runs, waiting for
confirmed compute release before starting. Running instant work is not interrupted
by another instant submission; incoming work queues. Instant chats take priority
among queued instant work. Completion refreshes the cooldown, keeping background
runs paused until desktop-away and cooldown requirements are satisfied. These
rules apply to continuations and to disabled agents invoked manually as well.

## Operational daemon logs

Configuration supports:

```json
"logging": {
  "level": "warn",
  "maxBytes": 1048576,
  "files": 3
}
```

Levels are `off`, `error`, `warn`, `info`, and `debug`. Existing installations
default to `warn`. Set logging through the existing revision-checked `config
update` command (or HTTP config PATCH). For example, put the current revision
from `config get` in this request, then run `nightcrew config update --request
logging.json`:

```json
{
  "expectedRevision": 2,
  "changes": {
    "logging": { "level": "debug", "maxBytes": 1048576, "files": 3 }
  }
}
```

The logging object replaces the previous object; omitted members use defaults.
Logging-only changes take effect live without unloading models, changing run
state, or waiting for the inference queue to empty. Foreground `daemon run
--quiet` overrides file logging. Finite CLI verbosity is separate and remains
on stderr; verbose CLI mode does not silently enable daemon debug logging.

Operational JSON lines go to `<home>/logs/daemon.jsonl`, with rotations `.1`
through `.9`. `files` includes the active file (1–10 total); `maxBytes` bounds
each file (1024 bytes–16 MB). Defaults retain at most three 1 MB files. Retention
and size reductions are enforced on the next emitted entry. `off` stops writes
but preserves existing logs. `nightcrew startup logs --lines 100` reads these
files as well as legacy launchd stdout/stderr; existing launchd files are not
rewritten or rotated by this logger.

The event/field allowlist in `src/logging.ts` is authoritative. Error/warn logs
cover unexpected worker exits, storage failures, snapshot failures and unhealthy
presence sampling. Info adds daemon lifecycle, presence recovery and model
switch duration; debug adds runtime readiness diagnostics. Missing or knowingly
incompatible snapshot caches are normal fallbacks and stay silent.

No prompts, completions, attachments, reasoning, tool payloads, run lifecycle,
configuration dumps, raw exceptions/stacks, or transcript-derived timing metrics
are logged. IDs only identify affected models/slots. Logs supplement existing
records rather than duplicating them. Even debug cannot bypass the field allowlist.

Repeated event/model-or-slot pairs are limited to one entry per 30 seconds; the
next emitted occurrence includes the suppressed count. The write queue is capped
at 128 entries and drops excess events rather than blocking inference or growing
without bound. Log I/O errors never fail a run: one sanitized `logging.unavailable`
notice is emitted on stderr per process if logging is enabled. Private directory
and file ownership checks reject unsafe or symlink log destinations.

Agents can set `temperature` from 0 to 2 (default 0.7). Like thinking and output
limits, temperature is captured in each run's agent snapshot. Audio models use
the latest user message's nonempty content as the transcription endpoint's
`prompt`; this is a transcription/vocabulary hint, not a chat system prompt.
The Granite example uses temperature 0 and a 200-token limit to match the chat client's
transcription request settings. Matching the chat client also requires matching audio cuts,
participant/vocabulary hints, and cleanup; this adapter does not infer them.

## Reviewing and exporting runs

```sh
nightcrew runs list --agent reviewer --state completed --limit 20
nightcrew runs transcript RUN_ID --limit 20
nightcrew runs search "search phrase" --agent reviewer --state completed --limit 20
# Repeat the same filters and limit with the returned cursor:
nightcrew runs list --agent reviewer --state completed --limit 20 --cursor CURSOR
nightcrew runs verify RUN_ID
printf '%s\n' '{"destination":"/absolute/new-bundle"}' | nightcrew runs export RUN_ID --request -
printf '%s\n' '{"bundle":"/absolute/new-bundle"}' | nightcrew runs verify RUN_ID --request -
nightcrew startup logs --lines 1000 --limit 50
nightcrew startup logs --lines 1000 --limit 50 --cursor CURSOR
```

Run list, transcript and search pages default to 50 entries, maximum 100. Their
cursors retain an immutable snapshot for five minutes in the daemon, expire on
restart, and require the same command, filters, query, run ID and limit. Replaying
a cursor returns the same page. These commands require a running daemon. Filters
and pagination can also be supplied through `--request`; specifying the same
field both ways is rejected. Search is case-insensitive literal substring search
of messages, text/JSON attachments, and results; it returns excerpts of at most
1,000 characters with source run/event IDs, without decoding audio as text.

Export and verify also work offline. Export creates a private directory that must
not exist, with `run.json`, `transcript.json`, `configuration.json`, `result.json`
and a SHA-256 `manifest.json`. The parent must exist. Destinations inside the
runtime home must be below `exports/`. `--dry-run` validates without writing.
Each document is bounded to 64 MB. A single committed state file supplies the
entire snapshot, including its revision and last event sequence; active generation
deltas are excluded. Attachments remain embedded in their messages. Export includes
the run's snapshotted agent, skills and tools, not the current mutable daemon/model
configuration, root token, model weights, slot caches or unrelated logs. Prompts,
tool results and attachments may themselves contain private information.

Verification returns `valid`, `checks` and `errors` without repairing files or
running tools. It checks schema, identity, event ordering, message/tool references,
selected skill/tool snapshots and attachment encoding. With `bundle`, it also
checks all file and attachment hashes and consistency across exported documents;
it verifies the bundle independently of the current run. Source runs have no
stored checksum baseline, so source verification cannot detect arbitrary valid
text edits. Checksums detect corruption, not authenticity. A successful command
may return `valid: false`; inspect the result.

Log pagination returns at most `--limit` lines total (default/maximum 100), grouped
by file. `--lines` selects the tail per file (default 100, maximum 10,000); each
file read is capped at 1 MB and partial leading lines are dropped. Order is
`daemon.jsonl`, rotations 1–9, then launchd stdout/stderr, with lines in file order.
Keep `--lines` and `--limit` identical when following a cursor. Any change to the
selected contents, file inventory or query invalidates the cursor; restart without
it. Log cursors work without a daemon and do not create snapshot files.

## Triggers and pending work

```sh
nightcrew triggers list
nightcrew triggers get TRIGGER_ID
nightcrew triggers create --request trigger.json
nightcrew triggers update TRIGGER_ID --request changes.json
nightcrew triggers enable TRIGGER_ID --request revision.json
nightcrew triggers disable TRIGGER_ID --request revision.json
nightcrew triggers delete TRIGGER_ID --request revision.json --yes
nightcrew triggers fire TRIGGER_ID
nightcrew queue list --agent AGENT_ID --state queued --limit 20
nightcrew queue get RUN_ID
nightcrew queue hold RUN_ID --request revision.json
nightcrew queue release RUN_ID --request revision.json
nightcrew queue cancel RUN_ID --request revision.json
```

A create request contains `trigger`: `{triggerID,name,agentID,enabled,schedule,
message,queuePolicy}`. Schedule is `{type:"manual"}`, `{type:"interval",everyMs}`
(minimum one minute), or `{type:"cron",expression,timezone}`. Cron accepts five
numeric fields with lists/ranges/steps and an explicit timezone, Sunday 0 or 7.
When both day-of-month and weekday are restricted, either can match. Nonexistent
DST times are skipped; repeated local times are distinct UTC occurrences. Next
occurrence lookup is bounded to five years. Intervals use a fixed anchor, reset
when enabled or their schedule changes. Missed occurrences are never caught up.

Automatic interval/cron dispatch runs while `scheduler.timersEnabled` is true.
The daemon admits due occurrences within a five-second tick tolerance, skips older
occurrences, and starts from the next future occurrence after restart. Manual `fire`
works now and does not shift the schedule. It requires a running daemon and an
enabled trigger and agent. Definitions can be managed offline. `fire --request`
accepts `{occurrenceID,message}`: both optional, where message replaces the saved
initial input and includes content/attachments plus optional thinking. Supply a
stable UUID as occurrenceID for retry safety; without it each call is a new
occurrence. Nightcrew uses it as the message UUID. Replays do not submit again;
changed explicit input under the same accepted UUID is rejected.

Queue policy defaults to `skip` while the same trigger has unfinished work.
`enqueue` preserves each distinct submission. `coalesce` retains one pending
input for the same trigger/agent revisions, provided the run has never started;
it preserves superseded input in the transcript but excludes it from inference.
Held work is still pending; paused, previously started work is never coalesced.
Coalesced occurrence history is bounded to 1,000 entries. Trigger edits do not
rewrite accepted definition snapshots. Disable/delete stops new submissions,
not existing runs. Dry-run previews create/coalesce/skip without writing.

Update requests use `{expectedRevision,changes}`; enable/disable/delete and queue
hold/release/cancel use `{expectedRevision}` from current inspection. Holds are
persisted in existing run state files, survive restart, and block dispatch even
on instant slots. Queue controls affect only queued or paused work; use `runs
cancel` for active work. List pagination follows the existing run cursor rules.
There is no separate queue database.

## Scheduler and persistent agents (0.12)

`scheduler get`, `scheduler update --request FILE`, `scheduler status` and
`scheduler explain` expose settings, allocations and policy decisions. Updates
use `{expectedRevision,changes}`. Defaults: `maxConcurrent: 1`,
`contextTokens: 4096`, `snapshotBudgetMB: 1024`, `minResidencyMs: 60000`,
`maxWaitMs: 900000`, `timersEnabled: true`, `hook: null`.

Set `instantModelID` to one configured chat model, for example `qwen`. Null uses
an existing legacy instant-slot model, then the first configured chat model.
`scheduler status` reports the effective model. Only that model gets an instant
slot. `inference submit` defaults to it and rejects a different explicit model.
Use `inference get REQUEST_ID` / `inference cancel REQUEST_ID` to inspect/cancel.
Instant work pauses background inference, waits for compute to release and keeps
background work stopped through the configurable interaction cooldown (five
minutes by default). Changing slot topology requires idle compute and no queued
interactive requests.

Background agents require healthy desktop-away presence and expired cooldown.
The scheduler runs compatible work concurrently on distinct slots of one loaded
model, batches resident-model work, and uses model/agent `priority` (default 0)
and `maxWaitMs` to balance urgency and fairness. It pauses work before switching
models; it does not load two models together. The instant model can be unloaded
for background work after cooldown. The default instant model has two physical slots: one reserved for instant
requests and one shared by background agents. Other models need only their
background slots. Increase `maxConcurrent` to opt into additional background
slots. Physical slots are derived, not created by users. Legacy slot definitions remain readable for migration.

Agents choose `contextMode: "fresh"` (default) or `"persistent"`.
Fresh agents clear the shared slot when taking it over and do not save a named
KV checkpoint. Turns within the same fresh run may reuse its in-memory context.
Persistent agents restore their own named checkpoint into that same shared slot,
then save it when yielding. Neither mode reserves a permanent physical slot.
A persistent agent has one stable run ID and transcript. Every accepted invocation
adds a segment; inputs arriving during execution wait for the current segment.
Configuration is snapshotted per accepted input. Cancellation also cancels pending
inputs. Natural completion waits for another invocation. `timeSliceMs` (default
60 seconds) pauses unfinished work; `timeoutMs` is the hard active-time budget
per segment. Paused time does not count. Compatible named KV snapshots follow the
agent across physical slots; missing/incompatible caches rebuild from transcript.
Persistent chat agents enable model snapshots. The global snapshot budget evicts
old caches; zero disables saving. Resetting a cache does not reset conversation.

An optional scheduler `hook` config supplies `executablePath`, `arguments`,
`timeoutMs` (default 2000) and `failurePolicy` (`builtin` or `hold`). The executable
receives one JSON snapshot on stdin (settings, eligibility/blockers, pending runs,
active allocations, slots and residency) and returns one JSON plan on stdout:
`{start:[{runID,slotID}],pause:[runID],reason}`. An empty plan intentionally waits.
Plans are revalidated against live state; hooks cannot bypass presence, cooldown,
capacity or model/slot safety. Invalid/timed-out hooks fall back or hold according
to policy. Hooks run without a shell and with bounded time/output.

### Thinking traces

Completed assistant messages record the effective `thinking` setting. When it is
true and the model emits reasoning, `reasoningContent` stores that text separately
from the answer in `content`. Turn overrides take precedence over the agent default.
Run files, transcript inspection and run exports retain the field. Old messages
without it remain valid; no reasoning is inferred or reconstructed retroactively.

The llama.cpp chat preset explicitly separates reasoning from answers. Nightcrew
collects streamed `reasoning_content`, including responses that call tools, and
bounds each trace to 1 MB. Disabled turns do not retain separate reasoning output.
Interrupted or failed generations retain partial answers, thinking and tool
fragments as separate attempt evidence, visible through transcript reads and
the agent history tool. They are not committed as completed assistant messages
and incomplete tool calls are never executed. Traces are
not copied into daemon logs or appended to future user-facing answer content.

## Compaction (0.13)

Models accept `compactionThresholdTokens` (positive integer, or `null` for the
context-capacity limit). Agents select an optional handler:

```json
{
  "compaction": {
    "handler": { "type": "agent", "agentID": "summarizer" }
  }
}
```

Or use a script:

```json
{
  "compaction": {
    "handler": {
      "type": "script",
      "executablePath": "/absolute/path/to/compact",
      "arguments": [],
      "timeoutMs": 60000
    }
  }
}
```

Configure these through the ordinary revision-checked `models update` and
`agents update` commands (inside `changes`). The summarizer must reference a
separate single-turn chat agent. Its compaction runs always start fresh, with its
own model, prompt, thinking setting and output limit; they cannot recursively
compact. No summarizer is installed or enabled automatically.

Before each managed chat-agent generation, Nightcrew applies llama.cpp's chat
template and tokenizes the assembled input, including tools and text attachments.
It compacts at the lower of the model threshold and the slot capacity minus the
agent's `maxOutputTokens`. Reserve a realistic output budget: a 4096-token output
limit cannot fit alongside any prompt in a 4096-token slot. Context shifting is
explicitly disabled. Audio and caller-owned instant inference are not automatically
compacted.

Both handler types receive this JSON request (on stdin for scripts, as user input
for compactor agents):

```json
{
  "version": 1,
  "runID": "original-run-id",
  "requestID": "uuid",
  "previousSummary": null,
  "messages": [],
  "targetTokens": 512
}
```

`messages` contains the older transcript portion being compacted, including stored
thinking and attachments. Treat its contents as data, not new instructions.
`targetTokens` is the requested summary budget; acceptance is determined by
recounting the complete reconstructed parent context. Return only
`{"summary":"nonempty summary text"}`. Scripts have a bounded timeout (default
60 seconds, maximum ten minutes), a 1 MB stdout limit, minimal environment, no shell,
and process-group cancellation. Summaries are limited to 262144 characters.
Scripts may be retried after interruption with the same request ID; make them
idempotent. Their elapsed execution counts as parent active work.

Nightcrew retains the system prompt and most recent complete turn, or a complete
recent tool exchange during a long agent loop. It replaces only the model-visible
older history with a summary. Full transcript messages and thinking traces remain
unchanged. Each accepted checkpoint records its coverage, summary, token counts,
and optional child run ID. The same parent run continues. KV snapshots include the
context checkpoint generation so stale pre-compaction state cannot be restored.

For agent handlers, the parent pauses and releases compute. A fresh linked child
run gets scheduling precedence over ordinary pending work, while still respecting
presence, cooldown, instant requests, slot capacity, and model residency. The
parent's active-time clock stops while waiting. Restart resumes the same child;
parent cancellation cancels unfinished compactor work. A compactor's own input
must fit its model; otherwise both it and the parent stop for recovery.

Failures, missing handlers, impossible output reservations, or summaries that
still exceed the budget leave the parent paused and held with `context_full`.
Nothing is silently discarded. Inspect `runs get` or `queue get` for the error,
fix the handler through `agents update`, then use revision-checked
`queue release RUN_ID --request revision.json` to retry. Release picks up the
agent's current compaction handler while preserving the run's other snapshots.
An oversized latest input/tool exchange may require cancellation and revised input
or larger context capacity; this version does not chunk compactor input.

Checkpoints and pending compaction state appear in run inspection and exports;
compaction events appear in transcripts. There is no separate compaction queue or
state database. Runtime adapter tests use local mocks; real-model summary quality
and throughput require separate validation.

## Shared contracts, evidence and storage (0.14)

Management CLI commands and HTTP operations derive from the same oRPC procedures
in src/operations.ts, with request schemas in src/operationInputs.ts. The private
control socket and offline CLI invoke these same procedures. HTTP mounts eligible
operations at POST /v1/operations/<resource>/<action>; the body contains request,
optional resourceID, and optional dryRun and yes flags. Legacy HTTP resource
routes remain compatibility adapters. TypeScript clients can import the
ManagementRouter type from nightcrew/operations. Local startup/bootstrap and
filesystem bundle operations remain local.

Agent storageLimitMB defaults to 48 MB (range 1–48). The limit measures serialized
run state and pauses growth at execution/admission boundaries; one final operation
may cross the threshold. A storage_limit hold preserves the persistent run ID and
history. Raise the agent limit and explicitly release the queue entry to continue
when capacity permits. Exporting does not free space. Automatic transcript pruning
or replacement at the maximum limit is not implemented.

Configure a run.storageLimit notification in config.hooks with executablePath and
timeoutMs. Its JSON stdin payload identifies the run, agent, segment, eventSequence
and storage usage (limitMB, bytes, messages, events, attempts). Delivery is recorded
once per boundary event/executable. The hook does not automatically release the
run; stdout is ignored. Context-compaction handlers remain separate and return
summaries rather than storage notifications.

Failed and interrupted attempts preserve available partial output and thinking,
including incomplete tool fragments. Successful attempts reference their committed
message. Checkpoints limit evidence loss on process crashes to unsaved deltas.
Run exports retain this evidence; agents with runs_transcript can inspect it.

The real-model suite is prepared but has not been run for this milestone.
See [live validation](docs/live-validation.md) for explicit opt-in instructions.
Default tests use mock inference.

### Passing tool parameters to a CLI

A tool's argv templates are configured once. For example, a tool that
invokes Nightcrew can use:

    executablePath: /absolute/path/to/nightcrew
    argv: ["runs", "list", "--request", "-"]

If the model supplies {"limit": 10}, Nightcrew writes that JSON followed by a
newline to stdin. The CLI's --request - consumes it using the normal runs.list
request contract. CLI JSON envelopes become the tool result on stdout. Include
--home and its absolute value in argv when targeting a nondefault runtime home.

For CLIs with flags or positional operands, use parameter placeholders directly:

    argv: ["runs", "transcript", "%runID%", "--limit", "%limit%"]

A model call with {"runID":"example-run","limit":10} launches the executable with
the run ID and limit in their configured positions, preserving each argument's
boundary. No wrapper is needed for this mapping. Only explicitly configured
placeholders become command-line arguments; JSON stdin is still supplied.

Placeholder rules:

- %name% selects a top-level parameter. %filter.owner% and %items.0% select
  nested own properties or array elements. Names use letters, digits, underscores
  or hyphens; the first segment must start with a letter or underscore.
- Placeholders may occupy a whole argument or part of one, such as --limit=%limit%.
- Strings are passed unchanged. Numbers, booleans, null, arrays and objects use
  compact JSON text. Arrays do not expand into multiple arguments.
- Missing values fail before launch. Mark parameters required, or provide schema
  defaults, when a template needs them. Optional flags are not automatically omitted.
- %% produces a literal percent; %%name%% passes the literal text %name%.
  Unmatched percent signs stay literal. Substituted values are never expanded again.
- Each expanded argument must be at most 4000 characters and contain no NUL.
  Spaces, quotes, percent signs and shell syntax inside values remain ordinary
  argument text. Nightcrew never invokes a shell to expand templates.

The parameters schema describes model-supplied JSON. The executable must still
return JSON on stdout. Wrappers remain useful for conditional flags, repeated
arguments, or converting non-JSON command output.

## On-demand skill folders (0.18)

An agent-loop run automatically receives the load_skills tool, even when toolIDs
is empty. Its initial model context includes only names and descriptions for the
agent's configured skillIDs. The skill body and resources enter context only
when the model requests them. Single-turn and audio agents remain tool-free.

The tool accepts these JSON requests:

    {}
    {"skillIDs":["review"]}
    {"files":[{"skillID":"review","path":"references/guide.md"}]}

The first discovers available skills. The second returns instructions and a file
manifest, without resource contents. The third reads a selected resource. Results
contain available, skills and files arrays. Requests can combine skillIDs and files;
unselected skill IDs and missing files are rejected. No script is executed merely
because it belongs to a skill folder.

A folder can look like this:

    ~/.nightcrew/skills/review/
      SKILL.md
      references/guide.md
      assets/template.json

After editing files directly, run nightcrew skills reload (or restart the daemon).
Reload validates the registry before replacing it. Existing admitted runs keep
their snapshots; subsequent submissions use the reloaded definitions.

For CLI/API creation, add a files array to the skill object:

    "files": [
      {"path":"references/guide.md","encoding":"utf8","content":"Review guidance"},
      {"path":"assets/template.json","encoding":"utf8","content":"{}"}
    ]

The existing skills create/update commands write the complete folder. Updates
that omit files retain current resources; an explicit files array replaces them.
Unrelated files in the folder are retained on update. Paths must stay within
references/ or assets/; symlinks and traversal are rejected. Each resource is at
most 128 KB, with at most 64 files and 512 KB of serialized resource data per skill.
Valid text is represented as UTF-8; binary assets use canonical base64. The API
normalizes encodings and path order so returned hashes match subsequent reads.

nightcrew skills read --request FILE reads configured skills through the same
on-demand contract. Add runID to read an admitted run's snapshots rather than
current definitions. Without runID this is an administrator read of the registry.
Run exports include snapshotted resources.

Instant chat requests accept skillIDs as well. Nightcrew advertises load_skills,
executes those calls, and continues inference within the same request deadline.
There are at most 16 model rounds and 4 MB of generated conversation messages;
the existing 6 MB admission limit includes the selected skill snapshots.
Client-defined tools are never executed by Nightcrew. In mixed batches it executes
skill calls and returns the remaining client calls. load_skills is a reserved
client tool name.

Inference get returns messages containing the generated assistant/tool exchanges.
Append those messages to client history (then any client tool results) before
submitting the next turn, so skill reads and tool-call pairing survive. Usage
aggregates all model rounds. Message and toolResult SSE events expose these
exchanges too. Instant snapshots remain memory-only and expire with the request;
they are not persisted request state.




## Recoverable tool-call errors

Agent-loop tool calls and Nightcrew-owned instant skill calls return failures as
structured tool messages: `{ "ok": false, "error": { "code": "...",
"message": "...", "outcome": "not_started" } }`. Malformed JSON, schema/argv
validation errors and unavailable tools do not terminate the run. Executable
failure, timeout, excessive output and invalid JSON output also return tool
errors, with `outcome: "unknown"` because a side effect may already have happened.
The agent can correct its request or continue with other evidence. Nightcrew does
not automatically replay failed calls. Each result retains the original tool-call
ID and is stored/streamed through the normal transcript path. Raw exception text,
stderr and invalid stdout are not included in these error messages.

Cancellation, preemption, active-work deadlines, storage failures and global
context/turn limits still stop or pause execution. They are not recoverable tool
errors. Client-owned instant tools remain the client's responsibility.
