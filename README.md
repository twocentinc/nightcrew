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

Agents, models, slots, skills and tools each provide `list`, `get <ID>`, `create`,
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

Agent updates use the agent’s `expectedRevision`. Config/model/slot updates use
configuration `expectedRevision`. Skill/tool reads include a content `hash`;
updates/deletes require `expectedHash`. Model creation accepts its model and
initial slots in one transaction, so the first model can include the required
instant slot. `config update` can replace model/slot arrays atomically for
larger topology changes. Referenced resources cannot be deleted; remove their
references first. No command downloads models or deletes model weights.

Edits go through `<home>/control.sock` while the daemon runs. The socket and home
are owner-only. With the daemon stopped, configuration commands acquire its
exclusive storage lock before editing. Model/slot/settings changes are rejected
while work is nonterminal; changing HTTP bind settings reports `restartRequired`.
Agent edits affect future runs. Skills and tool definitions are snapshotted in
new runs; historical runs retain their configuration.

`agents enable` / `disable` update eligibility. `agents run`, `runs list`,
`runs get`, `runs transcript`, `runs reply` and `runs cancel` operate through a
running daemon. Recurring dispatch policy remains deferred.

## Skills and tools

Skills use trusted `<home>/skills/<skillID>/SKILL.md` files. The CLI accepts a
structured skill object and writes bounded frontmatter and Markdown instructions.
Custom tools use `<home>/tools/<toolID>.json`.

Built-in tools are immutable: `load_skills`, `runs_list`, and `runs_transcript`.
Create named aliases using their adapter names, or custom executable tools with
`adapter: "exec"`. External tools require an absolute `executablePath`, an
`arguments` array, an object JSON Schema in `parameters`, `timeoutMs`, and an
explicit `readOnly: true`. See `schema get tools.create` for the full shape.

Nightcrew validates arguments, executes without a shell, sends one JSON input
on stdin, and expects JSON on stdout. Output is limited to 1 MB; timeouts and
interruption terminate the owned tool process group. Tools do not inherit the
HTTP root token or the daemon’s secret environment. The read-only declaration
is an administrator trust contract, **not an OS sandbox**; only configure
executables whose implementation honors it. Agents receive only their selected
tools. Built-in history adapters remain restricted to the same agent.

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

```sh
nightcrew slots save instant
nightcrew slots restore instant
```

These commands require the daemon and reject queued/active inference. Save
requires a loaded model; restore may load the model and evict the previous one.
Both support `--dry-run`. Snapshots must be enabled for that model. Saves use
unique cache files and atomically publish a manifest; the previous cache is
removed only after the new manifest is committed.

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
