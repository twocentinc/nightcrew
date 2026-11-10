# Nightcrew specification

Status: first discussion draft. The product definition and first-slice goals
below describe the intended behavior. Command names, paths, and policies marked
as proposed are examples for review. Nothing in this document is implemented.

## Product definition

Nightcrew is a standalone CLI and daemon for running recurring agents on local
models while the owner is away. The owner defines the crew once. The daemon
decides when to start work, gives each agent its configured skills and tools,
and keeps a transcript the owner can inspect and continue later. The first
targets are Qwen chat and Granite Speech served through one llama.cpp router
that Nightcrew manages on demand. The same daemon serves live chat clients and
accepts durable single-turn agent runs from local applications. Guildscribe's bundled
transcription hook is one such client; Guildscribe can replace it without
changing Nightcrew.

For example, the owner might define a library curator that reads recent
additions and suggests connections. On returning, the owner can read a
finding, inspect the records the curator consulted, and ask “what else
connects these two?” in the context of that particular run.

## First-slice goals

- Define multiple named agents, each with its own system prompt, selected
  skills, and allowed tools. A skill guides how an agent works; it cannot
  grant permission to call a tool.
- Check every 15 minutes whether the model is busy. When it is available and
  an agent is eligible, start one run. The interval is a dispatch check, not
  a run timeout or a requirement to run every agent every 15 minutes.
- Let a run take as many model and tool turns as it needs to reach a final
  answer, subject to limits still to be chosen. A later tick must not start
  a second agent run while the first is using tools or waiting for inference.
  For now, at most one Nightcrew-managed agent run may be active globally,
  across all models and slots. Manual starts and revived runs obey the same
  limit. Instant-slot requests preempt that agent under the interaction policy
  below; they do not launch another background agent run.
- Give agents only read-only tools. Nightcrew itself writes its configuration,
  transcripts, and run status. The tool executor must enforce the selected
  permissions on every call, including during follow-up chat.
- Let the owner list runs, read a result, inspect the full recorded exchange,
  and revive a completed run by replying to it.
- Accept single-turn Granite transcription agent runs from Guildscribe's bundled Nightcrew
  adapter without giving Guildscribe ownership of llama.cpp processes, model
  residency, or desktop presence policy.

## On-demand model serving

Starting the daemon does not require a running model server. When a run is
eligible, a chat client sends a turn, or the owner asks a follow-up question,
Nightcrew reuses its ready
server if it already has the requested model loaded. Otherwise, once capacity
is available, Nightcrew starts or reconfigures its server and waits for the
model to be ready before sending the first turn. An idle scheduling check
with no eligible work does not load a model.

Nightcrew owns one llama.cpp router and the lifecycle of the model instances it
starts beneath it. It does not take over a process started by the client application or
another application. The first-pass assumption is that the executable and
weights are already on disk; installing either is a separate provisioning
decision. Resolve `llama-server` through the daemon's `PATH` at startup and
reuse its validated absolute path. There is no llama-server `executablePath`
setting. Doctor reports the resolved executable and version locally; missing
or incompatible binaries fail clearly without downloads. An installed service
must supply an explicit PATH. Configured executable paths for lifecycle hooks
are unaffected.

The initial logical inference lanes are `qwen.fast`, `qwen.normal`, and
`granite.audio`. Qwen's slot count and context capacity are configurable; two
slots are an initial configuration, not an architectural limit. Slots in the
same Qwen model instance share one loaded copy of its weights while retaining
their own context state. Granite uses a separate model instance and audio
projector behind the same router endpoint. Nightcrew may keep both models
resident when capacity permits or unload Granite between runs. A single router
does not make the models share weights or inference contexts; it gives them one
lifecycle owner, request surface, and resource policy.

## Interactive clients and slot ownership

Nightcrew is the sole owner of the shared llama.cpp router, its model
instances, request queues, and slots. A local chat client supplies a stable
conversation ID, its
prompt and message history (including each message's attachments), and any available tool definitions. Nightcrew
streams the reply as it is generated and returns any requested tool calls to
the client. The client owns its transcript, tool permissions, execution, and
delivery to the user. Scheduled agents use Nightcrew's own run loop instead.

Configuration defines the available slots and assigns each agent to a specific
slot. Every invocation of that agent uses its configured slot rather than an
arbitrary free slot. External callers select a configured slot in their interactive request;
there is no client registry or hard-coded the chat client slot. Configuration designates an instant slot
for human interaction. Assignment to this special slot grants the preemption
and cooldown behavior below; ordinary slots do not gain it automatically.

Nightcrew associates each conversation with its conversation ID or agent and reuses
the matching processed prompt prefix when available. A slot assignment does
not make two different runs share conversation history. If a cache is lost,
the next turn can be processed from the supplied history; the cache is never
the transcript. Requests for a busy assigned slot queue rather than silently
moving to another slot.

The configuration must reference existing slots compatible with the assigned
model. Multiple agents may share a slot assignment. Switching between those
agents can displace the previous agent's cached context; their transcripts
remain separate. Whether to save and restore those caches, and how context
capacity maps to the selected llama.cpp build, remain design decisions.

## Instant slot and interaction cooldown

The instant slot represents active human interaction, regardless of desktop
presence. The initial `qwen.fast` lane uses it. A request immediately blocks
new background work and pauses the active agent so the interactive response
can run first. This must work during an ongoing generation, not only between
model calls. Nightcrew must stop the background computation before considering
the model available; closing its response stream alone is not sufficient.

Preserve completed agent messages and tool results when pausing. An incomplete
generation must not be committed as a completed answer or executable tool
call. The run stays paused, rather than failed or completed. The exact runtime
cancellation mechanism and whether an interrupted generation continues or is
regenerated from its last committed turn require validation.

After the instant queue drains and its last response finishes, start a
configurable interaction cooldown (`interactionCooldownMs`), defaulting to
300000 milliseconds (five minutes). Keep the instant model and conversation
cache hot and admit no background agent turns during this
period. Every new instant request cancels the countdown; start a fresh full
cooldown when interactive work drains again. Multiple instant requests queue
without releasing the background pause between them.

When the cooldown expires, resume the paused run before choosing new work,
provided desktop presence also reports that the owner is away.
Continuous human interaction may therefore defer background work indefinitely.
Cooldown expiry makes paused work eligible immediately rather than waiting
for the next 15-minute dispatch check.

`qwen.normal` serves ordinary agent turns and `granite.audio` serves recoverable single-turn transcription runs. Both yield to the instant slot and remain suspended during its
cooldown. Completed transcription runs remain durable across interruption.
An in-flight tool operation must be safely stopped or its eventual result
recorded without advancing the agent; it must not be blindly duplicated on
resume. Safe interruption details and handling of
failed or disconnected interactive requests remain to be specified.

All background agent runs, including single-turn runs, require both an away desktop and an
expired interaction cooldown, with no instant work pending. Neither condition
alone is sufficient. Returning to the desktop pauses background work even
without an instant request. Reuse the existing desktop presence detection in the client application
(`src/lib/server/desktopPresence.ts`) and its lifecycle integration as the
implementation precedent. Adapt it for standalone use without importing the
the client application runtime. Preserve its away criteria and fail-closed behavior: unknown
or unhealthy presence blocks background work until away is confirmed.

## Agent skills and tools

Use the chat client's existing skills and tools implementation as the starting point for
Nightcrew's managed agents. Adapt the implementation into a standalone
capability rather than making Nightcrew import the client application runtime code or
require the chat client. The extraction boundary, discovery and configuration format,
and initial read-only tool selection still need design.

An agent may load an earlier transcript through an explicitly allowed
read-only tool when its system prompt directs it to do so. Prior transcripts
are not automatically included in a new run.

## Run lifecycle and transcripts

An **agent** is a reusable definition. A **run** is one occasion on which
that definition works on its recurring assignment. A **result** is the final
answer from that run; “nothing new found” can be a valid result.

An agent has one of two execution modes:

- `single-turn`: produce one completed model response for the supplied input,
  without a tool execution loop. Use this for transcription, summarization,
  classification, and other bounded inference tasks. Tool calls are not
  executed; an unexpected tool-call-only response is an invalid outcome.
- `agent-loop`: alternate model responses and permitted tool execution until
  the agent finishes naturally or reaches its limits.

Single-turn agents use the same configuration, slot assignments, active-time
timeouts, scheduling gates, transcripts, hooks, cancellation, and restart
recovery as other agents. They may be invoked on demand without participating
in recurring dispatch. Every user message carries text and an attachments array. The initial
invocation and later replies accept the same message structure; structured
data is a JSON attachment. There is no separate run-level input.

Single-turn means one completed logical response. Interrupted attempts can be
regenerated on resume without becoming additional logical turns. A follow-up
to a completed single-turn run adds one response for that continuation; it
does not enable an autonomous tool loop.

Guildscribe invokes a configured single-turn transcription agent and observes
the resulting run through the ordinary runs interface. Each invocation or follow-up supplies a user message with a supported WAV
attachment and produces one transcription response. If audio
must be divided into chunks, each chunk is a separate single-turn run; chunk
preparation and result assembly belong to the submitting client, with their
exact contract still to be designed. There is no separate job entity, queue,
or API.

Proposed: give each run a stable ID and record the effective prompt, skills,
tool selection, and model at launch. In order, retain the conversation
messages, tool calls and returned results, and the final answer or reason
work stopped. Distinguish a natural completion from an interruption, failure,
or safety limit. If the daemon stops, the recorded portion should remain
readable after restart.

A new run starts with a blank conversation and its configured system prompt,
skills, and available tool definitions, without inherited messages, results,
or summaries. Consulting previous work is an explicit tool action. A reply targets a
specific run by ID and uses that conversation as context. Preserve the
original result and mark where the owner's follow-up begins so it is clear
what the agent discovered unattended.

Each agent has a configurable timeout measured in active execution time.
Time spent paused for presence, instant requests, cooldown, or daemon downtime
does not consume the budget. Persist consumed active time so restart recovery
does not reset it. The default duration and exact accounting boundaries for
queueing, model loading, and tool execution remain to be specified. A timeout is a distinct
stopped outcome, not a natural completion or an interruption to resume
indefinitely.

Interrupted runs resume, including after daemon restart, using durable
conversation and execution state. Recovery respects the one-agent limit,
desktop presence, and instant cooldown. Completed messages and tool results
must not be duplicated. The checkpoint format and safe handling of tool calls
whose outcome was not recorded before interruption still need definition.

## Result hooks

Use a hooks architecture similar to Guildscribe for run lifecycle events and
result delivery. Following that precedent, configured local executables receive
versioned JSON events on stdin, run without shell interpolation, and are
invoked after the corresponding run state is durable. Hook failures remain
inspectable without invalidating the run or its result.

Nightcrew retains its local transcript and result regardless of hook delivery.
External hooks can integrate with other applications without giving agents
write tools or embedding the client application-specific behavior in Nightcrew. Event
names, payloads, configuration, timeout, and retry/delivery guarantees remain
to be specified.

## JSON configuration and external supervision

Manage daemon and agent configuration in JSON files, with Nightcrew CLI
commands as the supported interface for inspecting and changing them.
The CLI must cover agent prompts, skills, tools, assigned slots, timeouts,
and enabled state so a supervisor does not need to edit files manually.
The proposed command surface appears below; exact JSON schemas remain to be designed.

An external supervisor, such as Astra, can review runs, inspect full
transcripts and tool activity, compare outcomes, and adjust agent definitions
through the CLI. Nightcrew does not depend on a particular supervisor model
or invoke a paid supervisor automatically. The background agents themselves
run on Qwen or similar local open-weight models.

Supervisor configuration commands are distinct from worker tools. Giving a
supervisor access to the CLI does not grant background agents configuration
writes or expand their read-only tool permissions. Proposed CLI guarantees
are structured inspection results, validated atomic updates, dry-run previews,
and revision checks to avoid overwriting concurrent edits. Record the effective
configuration with each run so later review can identify what produced it.
Agent configuration edits apply only to new runs. Active and paused runs
retain their original configuration snapshot, including when resumed after
a daemon restart.

## Runtime home and CLI

Keep runtime data outside the source checkout, selectable with
`--home <absolute-path>`. The proposed default is `~/.nightcrew`.

Use filesystem discovery rather than a central JSON array of runs:

```text
<home>/
  config.json
  runs/<runID>/state.json
```

Configuration holds daemon settings and agent definitions, never execution
history. Each run state file owns its configuration snapshot, status,
active-time accounting, committed transcript, result, and UUID-identified transcript messages.
Interactive requests stay only in bounded process memory. Run state identity
must match the containing directory.

Borrow Guildscribe's per-record artifact isolation, identity validation, and
same-directory atomic writes. Its current metadata storage is SQLite; Nightcrew
does not adopt that database. Lists and search discover records from disk and
may use a disposable in-memory index rebuilt after restart. Reading one run
does not require loading all transcripts, and updating one run never rewrites
another. There is no global run-count or all-history JSON size ceiling.

### Proposed command surface

These commands are a review draft, not implemented commands. Use
`nightcrew <resource> <action>` consistently. Once implemented, the runtime
command catalog and exported schemas will own the public contract.

| Command                                                       | Purpose                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `nightcrew help [resource [action]]`                          | Discover commands, arguments, and supported options as JSON.                                                                                |
| `nightcrew version`                                           | Report CLI and protocol versions.                                                                                                           |
| `nightcrew schema get <name>`                                 | Retrieve a versioned request or result schema.                                                                                              |
| `nightcrew init --request <file-or-dash>`                     | Validate and create initial configuration without overwriting an existing installation.                                                     |
| `nightcrew doctor`                                            | Check configuration, executable and model availability, presence sampling, and runtime-home health without loading models or starting work. |
| `nightcrew doctor --live`                                     | Probe the running daemon and its model-server health without starting inference or bypassing scheduling gates.                              |
| `nightcrew config get`                                        | Inspect daemon settings, including slots, model references, cooldown, and hooks; redact secrets.                                            |
| `nightcrew config update --request <file-or-dash>`            | Apply a validated daemon configuration change.                                                                                              |
| `nightcrew agents list`                                       | List agent IDs, names, enabled state, model, slot, timeout, and revision.                                                                   |
| `nightcrew agents get <agentID>`                              | Inspect the complete agent definition and revision.                                                                                         |
| `nightcrew agents create --request <file-or-dash>`            | Create an agent definition.                                                                                                                 |
| `nightcrew agents update <agentID> --request <file-or-dash>`  | Change supplied fields, preserving omitted fields.                                                                                          |
| `nightcrew agents enable <agentID> --request <file-or-dash>`  | Make the agent eligible for future automatic dispatch.                                                                                      |
| `nightcrew agents disable <agentID> --request <file-or-dash>` | Prevent future automatic dispatch without cancelling an existing run.                                                                       |
| `nightcrew agents run <agentID> --request <file-or-dash>`     | Queue a new manual run and return its run ID; obey presence, cooldown, and concurrency gates.                                               |
| `nightcrew skills list` / `skills get <skillID>`              | Inspect available skills and their instructions.                                                                                            |
| `nightcrew tools list` / `tools get <toolID>`                 | Inspect available tools, input contracts, and access classifications.                                                                       |
| `nightcrew runs list`                                         | List runs with agent, state, timestamps, and outcome; support agent/state filters and pagination.                                           |
| `nightcrew runs get <runID>`                                  | Inspect status, pause reason, result, configuration snapshot, and consumed/remaining active time.                                           |
| `nightcrew runs transcript <runID>`                           | Read ordered messages, tool calls, and results with pagination.                                                                             |
| `nightcrew runs search <query>`                               | Search saved transcript and result text with agent/state filters, returning bounded excerpts and source run/event IDs.                      |
| `nightcrew runs export <runID> --request <file-or-dash>`      | Export a portable, checksummed bundle of the transcript, result, and effective configuration to a new destination.                          |
| `nightcrew runs verify <runID>`                               | Read-only validation of run documents, references, event ordering, and available artifact checksums.                                        |
| `nightcrew runs reply <runID> --request <file-or-dash>`       | Append a follow-up and queue continuation using the original run configuration.                                                             |
| `nightcrew runs cancel <runID> --request <file-or-dash>`      | Stop queued, active, or paused work explicitly and preserve its recorded history.                                                           |
| `nightcrew daemon run`                                        | Run the daemon in the foreground.                                                                                                           |
| `nightcrew daemon status`                                     | Inspect presence health, cooldown, active/queued work, model residency, and slot assignments.                                               |
| `nightcrew daemon stop`                                       | Gracefully checkpoint and stop the daemon; interrupted work resumes after restart when eligible.                                            |
| `nightcrew startup install`                                   | Explicitly install and load the per-user background service for the selected runtime home.                                                  |
| `nightcrew startup uninstall`                                 | Stop and remove service registration while preserving configuration, runs, and model files.                                                 |
| `nightcrew startup status`                                    | Inspect service installation and running state.                                                                                             |
| `nightcrew startup start`                                     | Start an installed service.                                                                                                                 |
| `nightcrew startup stop`                                      | Gracefully stop the service and keep it stopped until explicitly started.                                                                   |
| `nightcrew startup restart`                                   | Checkpoint, stop, and start the installed service.                                                                                          |
| `nightcrew startup logs`                                      | Read bounded, paginated service and daemon diagnostics as JSON.                                                                             |

For commands shown in pairs, both have the `nightcrew` prefix.
Exact request fields and response schemas remain to be designed.
Skill/tool authoring commands, recurrence configuration, and deletion/retention
commands remain deferred. A separate `runs retry` command also remains deferred;
a fresh attempt uses `agents run`, while interrupted work resumes its existing
run automatically. Interactive client transport
and streaming are a separate contract; `runs reply` is a finite submission
command, not an interactive terminal chat session or an instant-slot bypass.

### Inspection, export, and service lifecycle

All inspection commands are read-only: listing, searching, reading transcripts,
verification, status, help, schemas, and logs never mark work reviewed, resume
a run, invoke hooks, or update its configuration. Searches return matching
locations rather than entire transcripts. Run lists, transcript reads,
searches, and logs accept `--limit` and `--cursor` with deterministic ordering
and bounded pages. Cursor validity and snapshot behavior must be documented
so a supervisor can safely walk changing history.

Scoped help includes command options and links by schema name to the request
and result contracts. Both help and schema discovery work without a running
daemon or initialized home.

Default doctor checks do not start services or load models. `doctor --live`
adds bounded health probes against existing services and reports an unavailable
daemon as such. It does not provision models or trigger test generations.

Export validates its structured destination request, rejects an existing
destination, and leaves the original run unchanged. It includes version and
run identity, transcript, result if available, configuration snapshot, and a
checksum manifest. Exclude credentials, model weights, KV caches, and unrelated
logs. For an active run, export a consistent committed snapshot and identify
its last included event. Verification reports errors without repairing or
rewriting files; checksums detect corruption, not authenticity.

Startup commands follow Guildscribe's per-user macOS LaunchAgent precedent.
Other service managers remain a platform decision. Installation is explicit,
supports dry-run, and rejects conflicting registrations rather than overwriting
them silently. Stop and restart preserve recoverable runs and respect the
configured eligibility gates when work resumes. Uninstall requires explicit
confirmation and removes only Nightcrew's service registration. It never
deletes runtime data. A service stop must suppress automatic service-manager
relaunch; `daemon stop` must not appear successful while the same installed
service immediately starts again. Service registration and foreground startup
must enforce one daemon owner for a runtime home.

### Supervisor-safe command behavior

Follow Guildscribe's JSON-first CLI conventions:

- Finite commands emit exactly one versioned compact JSON envelope on stdout.
  Progress and diagnostics go to stderr. Long-lived daemon operation is
  explicitly separate from finite command output.
- Provide `--home`, `--request-id`, `--timeout`, `--no-input`
  (with `--non-interactive` as an alias), and verbosity controls consistently.
  Durations require explicit units. CLI request timeout is distinct from an
  agent's active-time execution budget.
- Read structured changes and reply messages from JSON files or stdin through
  `--request`; reject unknown fields and validate before mutation.
- Configuration changes carry an expected revision. Reject stale revisions
  rather than overwriting a supervisor's concurrent edits. Write atomically.
  Creation fails on an existing identity; updates never silently create one.
- Meaningful mutations support `--dry-run` with a validated preview and no
  writes, dispatch, or hook delivery. Non-interactive mode never bypasses
  validation or required confirmation.
- Each new user turn has a client-generated UUID `messageID`. A retry reuses
  that UUID; a new intentional turn gets a new one. Committed transcript
  messages provide durable deduplication without a separate receipts array,
  submission key, or persisted payload hash. Request IDs remain diagnostic.
- Return stable error codes, exit classes, and retry safety
  (`safe`, `unsafe`, or `never`). State whether an idempotent operation
  changed anything. Do not require supervisors to parse human error prose.
- Cancellation is distinct from interruption: cancelled work does not
  automatically resume. Repeating cancellation must not compound effects.
- Agent edits affect new runs only. Manual starts may target disabled agents
  explicitly; disabling controls automatic dispatch. Daemon-setting changes
  that require a restart must report that requirement, never silently restart
  inference while work is active.

## HTTP interface

oRPC is the selected framework for the standalone TypeScript daemon. Use one
set of validated procedure contracts for the CLI OpenAPI client and the public HTTP surface. Nightcrew hosts its own
HTTP server; use oRPC OpenAPIHandler without mounting RPCHandler or /rpc.
No endpoint is registered in the client application. The routes and policies below are proposed for review; exact
request, response, and event schemas remain to be defined. No server or
dependency has been installed.

### Transport and access

Expose versioned HTTP routes under `/v1`, with SSE for incremental output.
Publish the generated OpenAPI document at `/openapi.json`. Keep llama.cpp's
own ports private to the daemon. Start bound to loopback by default; remote
access is explicitly configured, authenticated, and protected by HTTPS,
initially over the owner's Tailscale network. Bind addresses, TLS termination,
and credential provisioning remain deployment decisions.

All protected routes use one global root token in
`Authorization: global root token. Every token holder has full management,
inspection, and inference access. There are no client records, client IDs,
grants, ownership filters, or permission tiers. Bootstrap generates the token
locally, stores only `rootTokenHash`, and reveals the raw token once. The hash
is redacted from API responses and cannot be changed through config.update.
Health and generated OpenAPI remain public and disclose no instance secrets.

Interactive requests select a configured `slotID` whose model must match
`modelID`; only the designated instant slot triggers interactive priority.
Managed agents retain their configured slot assignment. Message UUIDs and
conversation IDs are globally scoped to this Nightcrew instance. Callers
should use globally unique conversation IDs to avoid collisions.

This does not give worker models root access. Tool allowlists and read-only
execution remain enforced internally; the token is never supplied to workers
or hooks.

### Resource routes

| HTTP route                                               | Purpose                                                                              |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `GET /health`                                            | Minimal liveness only; no paths, prompts, or configuration.                          |
| `GET /v1/status`                                         | Root-authenticated runtime status, presence, cooldown, queues, and model residency.  |
| `GET /v1/config`, `PATCH /v1/config`                     | Redacted configuration inspection and validated revision-checked edits.              |
| `GET /v1/agents`, `POST /v1/agents`                      | List or create agent definitions.                                                    |
| `GET /v1/agents/{agentID}`, `PATCH /v1/agents/{agentID}` | Inspect or update an agent, including enabled state.                                 |
| `POST /v1/agents/{agentID}/runs`                         | Queue a fresh managed run.                                                           |
| `GET /v1/runs`, `GET /v1/runs/{runID}`                   | Paginated history and one run's status, result, and configuration snapshot.          |
| `GET /v1/runs/{runID}/transcript`                        | Paginated committed transcript events.                                               |
| `GET /v1/runs/search`                                    | Search run evidence. Reserve this static path ahead of run-ID routing.               |
| `POST /v1/runs/{runID}/replies`                          | Append a follow-up and queue continuation.                                           |
| `POST /v1/runs/{runID}/cancel`                           | Explicitly cancel managed work without erasing history.                              |
| `GET /v1/runs/{runID}/events`                            | Subscribe to authorized run progress and lifecycle events.                           |
| `GET /v1/skills`, `GET /v1/skills/{skillID}`             | Discover skills and instructions.                                                    |
| `GET /v1/tools`, `GET /v1/tools/{toolID}`                | Discover tools and their schemas/access classification.                              |
| `POST /v1/chat/requests`                                 | Accept a externally maintained conversation turn; return a request ID and event URL. |
| `GET /v1/chat/requests/{requestID}`                      | Inspect terminal status/result or current request state.                             |
| `GET /v1/chat/requests/{requestID}/events`               | Stream text deltas, completed tool calls, usage, and terminal outcome.               |
| `POST /v1/chat/requests/{requestID}/cancel`              | Explicitly cancel an interactive inference request.                                  |

Administrative CLI commands call these HTTP operations; enable/disable are
agent updates rather than separate state implementations. Run verification,
export, daemon control, and service logs need additional contracts. Service
installation and credential bootstrap remain local operations. Never expose
arbitrary server filesystem destinations through a remote export request;
remote clients should receive a download and write it on their own machine.
Similarly, remote audio inputs for single-turn runs need an upload/artifact-reference contract rather
than treating a client-local path as a path on the server.

### Submission and streaming lifecycle

Chat submission supplies a conversation ID, model reference, complete message
history with per-message attachments, tool definitions, and generation options. Interactive requests name a configured slot; its instant designation
determines priority. Nightcrew performs inference; the
client executes returned tools and submits the next conversation turn. Reject
overlapping turns for the same conversation in the initial version.

Validate a submission before accepting it. Acceptance returns HTTP 202 with
its identity, state, and observation URL; it does not mean generation has
finished. Use client-generated message UUIDs to deduplicate run and reply submissions
from committed transcripts. Interactive submissions deduplicate only while
their process-local records are retained. Reusing a message UUID with different
content or a different target is a conflict. A trace/request ID is a
separate diagnostic identifier.

SSE events have explicit types, ordered IDs, and structured payloads. Proposed
types include queued, started, text delta, tool call completed, paused,
resumed, completed, failed, and cancelled, restricted to the relevant resource.
Only a completed, validated tool call is actionable; partial arguments are not.
Define bounded event replay and cursor expiry explicitly. A reconnect must not
start another generation. Interactive terminal status and replay remain
available only within the in-memory retention period. Persistent run transcripts remain separate from transient stream
delivery.

A streaming disconnect is not cancellation. An accepted request continues
until completion, explicit cancellation, or its timeout. Durable runs
also survive observer disconnects. Restart discards interactive request state;
lookups return request_unavailable rather than a fabricated interrupted result.
A client can explicitly submit again, with no cross-restart deduplication
guarantee for interactive requests. Durable managed runs retain their automatic recovery
policy. Cancellation must reach the scheduler and underlying computation, not
merely close the SSE connection.

Interactive request state, results, events, and message UUID lookup are
memory-only, retained for 15 minutes after termination within a bounded memory
budget. No request-state files are written. Cooldown remains persisted in
configuration; at startup wait at least a full configured cooldown, preserving
any later existing deadline, before allowing background work.

The instant cooldown starts after the last admitted instant request reaches a
terminal state and the instant queue drains, including cancellation or failure.
Invalid or unauthorized requests do not activate instant mode.

### Message identity and retry behavior

The client generates a UUID `messageID` for every new submitted turn. Start-run
and reply accept `message: {messageID, content, attachments}`. A new UUID
means a new turn even if the content is identical. Retries reuse the same UUID.
Normalize UUIDs to lowercase and use a global message UUID lookup. Compare stored text, ordered attachments and original target; a UUID
reused with changed content or target returns `409 message_conflict`.

Persist the user message with the accepted run state in one atomic commit.
Rebuild lookup from transcript messages after restart. No separate submission
keys, receipts collection or persisted payload hashes are needed. Check for a
replay before applying current lifecycle admission rules, but always enforce
current authorization. Return the original run ID and segment on replay.

For interactive chat, the final submitted message's UUID identifies the new
inference request; it may be a user message or a tool result when the client
continues a tool loop. Historical message UUIDs are not new submissions.
Compare the original submitted history, tools, model, slot, conversation ID and
generation options when replaying. UUID lookup lives only as long as the
in-memory request; restart or expiry removes its deduplication guarantee.
Server-produced messages receive server-generated UUIDs. These IDs do not
replace HTTP trace IDs, run IDs, request IDs or tool-call IDs.

### Shared contract rules

Use versioned schemas, stable structured errors, bounded pagination, explicit
duration units, and revision conflicts consistently across HTTP and CLI.
Authorization applies to individual resources and stream subscriptions, not
just route access. Paginated inspection does not change state. HTTP errors
retain meaningful status codes; the CLI converts them to its stable JSON
envelope and exit classes rather than requiring HTTP to imitate stdout.

Define body/audio size limits, queue limits, event retention, global
resource limits, and timeout ceilings before implementation. Bind the approved
schema definitions to oRPC input/output validation and generate OpenAPI from
those definitions rather than maintaining a second handwritten contract.

### Detailed HTTP review contract

This section is the review contract for Nightcrew’s own server. the client application’s
Endpoint proposal validator requires RPC-style method paths and cannot
represent HTTP verbs or parameterized REST routes faithfully. The former
Endpoint proposal is withdrawn; no RPC aliases are part of this contract.
This section is authoritative until runtime validators and generated OpenAPI
replace it. The library name oRPC does not imply a separate RPC transport.

Messages use text in `content` and an `attachments` array. Each attachment
is `{name, mediaType, dataBase64}`. Both run creation and follow-up replies
accept `message: {messageID, content, attachments}`; the server supplies the user role.
The same representation applies to every user message in interactive chat.
There is no run-level `input` or `inputs` field. Files can arrive later.

These are inline attachments, not uploaded server paths. Initial supported
types are UTF-8 text/plain, application/json, and PCM audio/wav. Model
capabilities constrain combinations: the initial Granite adapter accepts one
WAV on the current turn, while text adapters accept text/JSON files. A
message may contain up to 16 attachments and 8 MB decoded total; existing
per-run and interactive-memory limits still apply. Reject unsupported media
before accepting work. Later binary/artifact-reference support needs a
separate contract. No upload or filesystem proxy endpoint is introduced.

#### GET /health

Minimal liveness only; no storage or model readiness guarantee. Authorization: public. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

No fields.

Response:

- `ok` — boolean (required). Always true if process is responding.
- `version` — string (required). Package version.

#### GET /openapi.json

Generated OpenAPI document with no instance state or credentials. Authorization: public. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

No fields.

Response:

- `document` — OpenAPI document (required). Raw generated OpenAPI 3.x JSON as response body; describe the REST bindings of this manifest.

#### GET /v1/status

Read-only operational status. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

No fields.

Response:

- `presence` — object (required). state present|away; reason; samplingHealthy; observedAt ISO date; sanitized diagnostic.
- `cooldownUntil` — ISO date string (required, nullable). End of instant cooldown.
- `activeRunID` — string (required, nullable). Current managed run.
- `queue` — object[] (required). Resource IDs, kinds run|chat, state and blocking reason.
- `models` — object[] (required). modelID and state unloaded|starting|ready|stopping|failed; no paths.
- `slots` — object[] (required). slotID, modelID, index, contextTokens, instant, busy; conversation association available to root-authenticated callers.

#### GET /v1/config

Inspect public config projection. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

No fields.

Response:

- `config` — PublicConfig (required). store config fields revision, host, port, interactionCooldownMs, models (modelID,kind,idleUnloadMs), slots (all fields), hooks (event,timeoutMs). Never rootTokenHash or executable/model paths.

#### PATCH /v1/config

Partial edit; topology/bind changes with nonterminal work rejected. Local executable/model paths and credential hashes are bootstrap-only and not remotely writable. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `expectedRevision` — integer (required). Positive current resource revision; stale revisions return 409.
- `changes` — object (required). Optional fields interactionCooldownMs (0..3600000), slots (complete slot array), modelIdlePolicies (modelID,idleUnloadMs array). Existing model IDs only; unknown fields rejected. All changes atomic; no paths, token hashes, hooks executable changes or listener binding accepted.
- `dryRun` — boolean (optional). Optional false; validates and returns preview without persistence, hooks or queue changes.

Response:

- `config` — PublicConfig (required). Same redacted projection as config.get.
- `changed` — boolean (required). Whether operation committed a new mutation.
- `restartRequired` — boolean (required). True for idle topology changes requiring next controlled startup; never auto-restarts active inference.

#### GET /v1/agents

Paginated authorized definitions. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `limit` — integer (optional). 1..100, default 50.
- `cursor` — string (optional). Opaque query-bound cursor over a bounded immutable in-memory result snapshot, valid for five minutes. Subsequent state changes do not invalidate traversal. Expiry or daemon restart returns 410 cursor_expired; caller restarts. No global store revision.
- `enabled` — boolean (optional). Optional enabled-state filter.

Response:

- `items` — Agent[] (required). nightcrew.store v2 $defs.agent, all fields; API omits nothing from agent definition, but only authorized clients see it.
- `nextCursor` — string (required, nullable). Continuation cursor, otherwise absent-as-null.

#### POST /v1/agents

Create immutable identity with revision 1; existing ID conflict. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `agent` — AgentDraft (required). store agent fields agentID,name,systemPrompt,mode,modelID,slotID,skillIDs,toolIDs,timeoutMs,enabled; omit revision/timestamps. timeoutMs optional defaults 1800000. Other fields required. Validate referenced model, slot, skill and tool registry.
- `dryRun` — boolean (optional). Optional false; validates and returns preview without persistence, hooks or queue changes.

Response:

- `agent` — Agent (required). nightcrew.store v2 $defs.agent, all fields; API omits nothing from agent definition, but only authorized clients see it.
- `changed` — boolean (required). Whether operation committed a new mutation.

#### GET /v1/agents/{agentID}

Inspect authorized definition. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `agentID` — string (required). Path ID of an existing agent.

Response:

- `agent` — Agent (required). nightcrew.store v2 $defs.agent, all fields; API omits nothing from agent definition, but only authorized clients see it.

#### PATCH /v1/agents/{agentID}

New revision applies to future runs only. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `agentID` — string (required). Path ID of an existing agent.
- `expectedRevision` — integer (required). Positive current resource revision; stale revisions return 409.
- `changes` — AgentPatch (required). Any nonempty subset of name,systemPrompt,mode,modelID,slotID,skillIDs,toolIDs,timeoutMs,enabled with same validation as create. IDs and timestamps immutable.
- `dryRun` — boolean (optional). Optional false; validates and returns preview without persistence, hooks or queue changes.

Response:

- `agent` — Agent (required). nightcrew.store v2 $defs.agent, all fields; API omits nothing from agent definition, but only authorized clients see it.
- `changed` — boolean (required). Whether operation committed a new mutation.

#### POST /v1/agents/{agentID}/runs

Persist snapshot and queue manual execution; disabled agent allowed for explicit submission. No bypass of away/cooldown gates. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `agentID` — string (required). Path ID of an existing agent.
- `message` — UserMessage (required). Strict {messageID:UUID,content:string <=262144,attachments:Attachment[] <=16}, with attachments {name,mediaType,dataBase64} from nightcrew.run v1. Text or files may be supplied initially or in any later reply. No run-level input. Empty initial message allowed for prompt-only agents; replies require nonempty text or at least one attachment. Total decoded attachment bytes <=8 MB and body <=16 MB; validate model compatibility before acceptance.
- `dryRun` — boolean (optional). Optional false; validates and returns preview without persistence, hooks or queue changes.

Response:

- `runID` — string (required). Persisted identity, HTTP 202 on first acceptance; 200 on exact replay.
- `status` — string (required). Outcome state from target record.
- `eventsURL` — string (required). Relative URL /v1/runs/{runID}/events.
- `replayed` — boolean (required). True only for identical idempotent replay.

#### GET /v1/runs

Read run history; stable createdAt/runID ordering. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `limit` — integer (optional). 1..100, default 50.
- `cursor` — string (optional). Opaque query-bound cursor over a bounded immutable in-memory result snapshot, valid for five minutes. Subsequent state changes do not invalidate traversal. Expiry or daemon restart returns 410 cursor_expired; caller restarts. No global store revision.
- `agentID` — string (optional). Optional agent filter.
- `state` — RunState (optional). Optional exact state from store run schema.

Response:

- `items` — RunSummary[] (required). runID, agentID, state, segment, createdAt, updatedAt, activeMs, remainingMs, pauseReason, revision. No prompt/transcript in listings.
- `nextCursor` — string (required, nullable). Continuation cursor, otherwise absent-as-null.

#### GET /v1/runs/{runID}

Read run detail without transcript pages. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `runID` — string (required). Path ID of authorized run.

Response:

- `run` — RunDetail (required). runID, agentID, state, segment, createdAt, updatedAt, activeMs, remainingMs, pauseReason, revision. No prompt/transcript in listings. Plus agent snapshot, skill snapshots, result, error, hook delivery status. No root-token hash or raw hook paths.

#### GET /v1/runs/{runID}/transcript

Paginate durable committed evidence. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `runID` — string (required). Path ID of authorized run.
- `limit` — integer (optional). 1..100, default 50.
- `cursor` — string (optional). Opaque query-bound cursor over a bounded immutable in-memory result snapshot, valid for five minutes. Subsequent state changes do not invalidate traversal. Expiry or daemon restart returns 410 cursor_expired; caller restarts. No global store revision.

Response:

- `items` — TranscriptEntry[] (required). Ordered committed events with referenced message content, attachments, role, toolCalls and toolCallID resolved from the run transcript. Message attachments remain associated with that message; no duplicate storage of payload in events. Bounded pagination and authorized access apply.
- `nextCursor` — string (required, nullable). Continuation cursor, otherwise absent-as-null.

#### GET /v1/runs/search

Literal case-insensitive substring search of permitted committed text; reserve static route ahead of run ID. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `limit` — integer (optional). 1..100, default 50.
- `cursor` — string (optional). Opaque query-bound cursor over a bounded immutable in-memory result snapshot, valid for five minutes. Subsequent state changes do not invalidate traversal. Expiry or daemon restart returns 410 cursor_expired; caller restarts. No global store revision.
- `query` — string (required). 1..200 characters; no regex syntax.
- `agentID` — string (optional). Optional agent restriction.
- `state` — RunState (optional). Optional state filter.

Response:

- `items` — SearchMatch[] (required). runID, eventSequence, segment, excerpt (up to 1000 chars), matchOffset; records accessible with the root token.
- `nextCursor` — string (required, nullable). Continuation cursor, otherwise absent-as-null.

#### POST /v1/runs/{runID}/replies

Completed runs only; append user turn, increment segment, retain original config and prior result events, reset segment activeMs to zero, queue continuation. Other states return 409. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `runID` — string (required). Path ID of authorized run.
- `message` — UserMessage (required). Strict {messageID:UUID,content:string <=262144,attachments:Attachment[] <=16}, with attachments {name,mediaType,dataBase64} from nightcrew.run v1. Text or files may be supplied initially or in any later reply. No run-level input. Empty initial message allowed for prompt-only agents; replies require nonempty text or at least one attachment. Total decoded attachment bytes <=8 MB and body <=16 MB; validate model compatibility before acceptance.
- `dryRun` — boolean (optional). Optional false; validates and returns preview without persistence, hooks or queue changes.

Response:

- `runID` — string (required). Persisted identity, HTTP 202 on first acceptance; 200 on exact replay.
- `status` — string (required). Outcome state from target record.
- `eventsURL` — string (required). Relative URL /v1/runs/{runID}/events.
- `replayed` — boolean (required). True only for identical idempotent replay.

#### POST /v1/runs/{runID}/cancel

Cancel queued/running/paused run; retain evidence and stop compute before dispatching replacement. Terminal run returns unchanged. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `runID` — string (required). Path ID of authorized run.
- `dryRun` — boolean (optional). Optional false; validates and returns preview without persistence, hooks or queue changes.

Response:

- `runID` — string (required). Run ID.
- `status` — string (required). Outcome state from target record.
- `changed` — boolean (required). Whether operation committed a new mutation.

#### GET /v1/runs/{runID}/events

Subscribe without running/resuming work. Replays committed events then tails; 15s heartbeat; max 10 streams globally, slow consumers disconnected, no execution cancellation. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `runID` — string (required). Path ID of authorized run.
- `afterEventID` — integer (optional). Nonnegative event sequence, default 0; Last-Event-ID header equivalent, disagreement is 400. Unknown future IDs rejected.

Response:

- `events` — SSE stream (required). Each event has eventID, type, at, resourceID, segment, data; types queued,started,paused,resumed,message,toolResult,completed,failed,cancelled,timedOut,interrupted,hookResult,textDelta. Lifecycle/committed evidence replay from durable store; textDelta transient and identified by attemptID with reset on reconnect. Client replaces provisional text from final committed result; never appends partial old attempt to new response.

#### GET /v1/skills

Discover authorized registry entries. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `limit` — integer (optional). 1..100, default 50.
- `cursor` — string (optional). Opaque query-bound cursor over a bounded immutable in-memory result snapshot, valid for five minutes. Subsequent state changes do not invalidate traversal. Expiry or daemon restart returns 410 cursor_expired; caller restarts. No global store revision.

Response:

- `items` — Skill[] (required). store $defs.skill; selected Markdown instructions adapted from the chat client's bounded frontmatter parser. Registry sources are local trusted skills directories, no the client application imports.
- `nextCursor` — string (required, nullable). Continuation cursor, otherwise absent-as-null.

#### GET /v1/skills/{skillID}

Read one registry entry. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `skillID` — string (required). Registry identity.

Response:

- `skill` — Skill (required). store $defs.skill; selected Markdown instructions adapted from the chat client's bounded frontmatter parser. Registry sources are local trusted skills directories, no the client application imports.

#### GET /v1/tools

Discover authorized registry entries. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `limit` — integer (optional). 1..100, default 50.
- `cursor` — string (optional). Opaque query-bound cursor over a bounded immutable in-memory result snapshot, valid for five minutes. Subsequent state changes do not invalidate traversal. Expiry or daemon restart returns 410 cursor_expired; caller restarts. No global store revision.

Response:

- `items` — Tool[] (required). toolID, description, parameters JSON Schema, readOnly=true; v1 registry load_skills, runs_list, runs_transcript. Each input strictly validated. load_skills takes skillIDs already in snapshot; history tools are scoped to run's agentID.
- `nextCursor` — string (required, nullable). Continuation cursor, otherwise absent-as-null.

#### GET /v1/tools/{toolID}

Read one registry entry. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `toolID` — string (required). Registry identity.

Response:

- `tool` — Tool (required). toolID, description, parameters JSON Schema, readOnly=true; v1 registry load_skills, runs_list, runs_transcript. Each input strictly validated. load_skills takes skillIDs already in snapshot; history tools are scoped to run's agentID.

#### POST /v1/chat/requests

Accept externally maintained turn; configured model/slot compatibility enforced, one outstanding turn per conversation, no background managed-run count increment. Only configured instant slot gets preemption. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply.

Request:

- `conversationID` — string (required). Globally unique conversation ID; no client namespace.
- `slotID` — string (required). Configured slot ID; must match modelID. Its instant designation controls priority.
- `modelID` — string (required). Configured model matching the requested slotID; chat models only.
- `messages` — Message[] (required). nightcrew.run v1 message objects {messageID,role,content,attachments,toolCalls,toolCallID}; complete client history, maximum 1000 messages. Each user message may include attachments. Initial chat adapter supports text/plain and application/json only; unsupported media returns 400. In-memory request/output budget remains enforced; valid tool-call/result pairing required.
- `tools` — FunctionTool[] (optional). Array of strict objects {name:string 1..128,description:string <=2000,parameters:JSON Schema object}; maximum 64 with unique names. No tool execution by Nightcrew. Empty default.
- `timeoutMs` — integer (optional). 1000..600000 default 120000 elapsed request budget including queue time.
- `maxOutputTokens` — integer (optional). 1..32768 default 4096.
- `temperature` — number (optional). 0..2 default 0.7.

Response:

- `requestID` — string (required). Process-local request identity; 202 first acceptance, 200 retained replay. Lost at restart or retention expiry.
- `status` — string (required). Outcome state from target record.
- `eventsURL` — string (required). Relative chat event stream URL.
- `replayed` — boolean (required). Idempotency replay.

#### GET /v1/chat/requests/{requestID}

Inspect request status and final output. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply. Unknown, expired, or pre-restart request IDs return 404 request_unavailable; never fabricate an interrupted result.

Request:

- `requestID` — string (required). Path ID of an interactive request.

Response:

- `request` — ChatDetail (required). requestID, conversationID, modelID, state, createdAt,updatedAt,result{text,toolCalls,usage{inputTokens,outputTokens}},error; result/error nullable; no credential or raw prompt.

#### GET /v1/chat/requests/{requestID}/events

Subscribe/reconnect without starting inference. Generation survives network disconnect. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply. Unknown, expired, or pre-restart request IDs return 404 request_unavailable; never fabricate an interrupted result.

Request:

- `requestID` — string (required). Path ID of an interactive request.
- `afterEventID` — integer (optional). Nonnegative event sequence, default 0; Last-Event-ID header equivalent, disagreement is 400. Unknown future IDs rejected.

Response:

- `events` — SSE stream (required). Each event has eventID, type, at, resourceID, segment, data; types queued,started,paused,resumed,message,toolResult,completed,failed,cancelled,timedOut,interrupted,hookResult,textDelta. Interactive lifecycle/output replay from bounded process memory only; textDelta transient and identified by attemptID with reset on reconnect. Client replaces provisional text from final committed result; never appends partial old attempt to new response.

#### POST /v1/chat/requests/{requestID}/cancel

Explicitly stop request computation, record cancellation in memory and start cooldown when instant queue drains; already terminal unchanged. Authorization: global root token. Shared limits/errors and persistence semantics in document summary and alternatives apply. Unknown, expired, or pre-restart request IDs return 404 request_unavailable; never fabricate an interrupted result.

Request:

- `requestID` — string (required). Path ID of an interactive request.
- `dryRun` — boolean (optional). Optional false; validates and returns preview without persistence, hooks or queue changes.

Response:

- `requestID` — string (required). Target identity.
- `status` — string (required). Outcome state from target record.
- `changed` — boolean (required). Whether operation committed a new mutation.

#### Shared HTTP behavior

**Shared HTTP validation, authorization and error contract**

Global root-token bearer authentication on every protected request/stream; health/OpenAPI public. Constant-time SHA-256 comparison against rootTokenHash; no client identity, grants, ownership filters or role tiers. Missing credential 401, denied capability 403, nonexistent/inaccessible object 404, malformed input 400, stale revision/message UUID conflict/overlap 409, stale stream cursor 410, oversized input 413, queue/per-record capacity 429/507, unavailable runtime 503, execution timeout 504. Error body {code,message,retrySafety,requestID,details}; no stack/secrets. Enforce JSON body <=16 MB, total queue <=100, request deadline/body timeout, strict unknown-field rejection. Generic bound serialized tool result 1 MB. Methods with dryRun return validated previews without committing messages or events.

**Runtime, tools and recovery semantics**

One daemon owns private loopback llama.cpp router, configured slots and models. Active instant compute pauses one background run, confirms release of slot before instant generation, and holds all background work for cooldown default 300000ms + healthy desktop-away. On failure to confirm release, stop only Nightcrew-owned model child and mark cache cold; never kill a pre-existing server. Avoid false guarantee of uninterrupted GPU execution: cancellation must be validated against selected build. Model weights are existing configured absolute files; no download. Presence copied/adapted from desktopPresence.ts (locked/switched-out or ten-minute idle; sampling failure blocks); poll every 5s while background active. Tool registry initially load_skills/runs_list/runs_transcript only, all read-only and scoped; preserves the chat client's function definitions, skill loading and validation patterns without an arbitrary proxy. A valid completed turn ends single-turn; loop mode executes completed tool calls then continues. User-message WAV attachments decode to a private temporary WAV for Granite and are removed after inference; original bytes remain in that message. Text/JSON attachments are rendered as message-local context. No arbitrary remote server paths. Hooks run executable directly with bounded sanitized environment and timeout, versioned event JSON stdin, persisted receipt before invocation, at-most-once attempts, failures recorded. Resolve llama-server once through PATH at startup, validate capabilities, and launch the resolved absolute binary. There is no executablePath setting for llama-server. Hook executable paths remain explicitly configured; this change does not remove hook paths.

**Independent filesystem records and rebuildable in-memory discovery**

config.json owns settings, agents and cooldown only. runs/<runID>/state.json independently owns durable execution, committed events, results and UUID-identified messages; chat records are memory-only. No central execution list, database or history-wide size/count ceiling. Discover records from directories, load requested evidence lazily, and rebuild a bounded in-memory summary/message UUID index with bounded-concurrency reads. Initial run publication atomically publishes the initial UUID-identified user message and accepted state together; replies commit their UUID-identified message and continuation state in that same run file. Single daemon lock serializes writes and admission. Each record has a 64 MB cap including 8 MB settlement reserve; failures never acknowledge uncommitted state. Startup reconciles interrupted runs; unreadable records are reported and excluded from execution, with submissions blocked if idempotency safety cannot be established. Persist cooldown separately, without request files. Every daemon start waits at least one configured cooldown (or longer if persisted deadline requires it), with desktop-away still required. No arbitrary filesystem access from clients.

**Ephemeral chat vs durable agent execution**

Disconnect never cancels accepted work. Chat state, replay events, final output and message UUID lookup exist in bounded process memory only. Retain terminal requests for 15 minutes, aggregate request memory budget 64 MB and per-request 8 MB, reject admission when reservations cannot fit rather than silently evicting live or unexpired requests. Bound outputs/events within the reservation; slow streaming observers cannot accumulate unbounded buffers. Expiry or restart makes get/events/cancel return 404 request_unavailable. Same-message-UUID replay is guaranteed only while its record is retained in the current process; clients must explicitly decide to resubmit after unknown outcome, never automatically claim a retry is deduplicated. No request prompts/results persisted in logs. Chat uses explicit cancel or elapsed timeout, default 120s maximum 600s. Restart destroys all pending chat state, stops only Nightcrew-owned computation and begins conservative persisted instant cooldown. Managed agents remain durable, with default 30-minute active timeout excluding queue/pause/downtime and one-second charging checkpoints. Replies to completed runs preserve original config and start a new segment; failed/cancelled/timedOut runs need a fresh invocation.

## Integration boundary

The local result and transcript should be useful without the client application.
the chat client is one potential client of the same interface available to any bot.
the client application would keep the chat client's behavior and replace its direct Qwen server calls
with Nightcrew requests. Guildscribe remains the source of truth for Discord
recordings and transcripts while its bundled transcription hook asks Nightcrew
to invoke a single-turn Granite agent and return structured results. An owner may
replace that hook with another transcriber. Nightcrew must work with no the chat client,
Guildscribe, or the client application code, identity, configuration, or installation; each
is a client of a generic local interface.
A future the client application panel could edit agents or display runs. A finding that
needs a decision could become a linked Proposal. Neither a panel nor Proposal
publication is a prerequisite for the standalone workflow. No agent gets a
write tool to file Proposals in the first slice.

## Decisions still open

| Decision                       | Question to settle                                                                                                                                                                                                                                                 |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provisioning and unloading     | Should Nightcrew also install llama.cpp or fetch missing model weights? How long should Qwen and Granite stay warm between requests?                                                                                                                               |
| Client interface and migration | Review the proposed oRPC HTTP routes, root authentication, SSE replay limits, and single-turn run input/audio upload contract. How will the client application hand off Qwen ownership and Guildscribe's bundled hook submit audio without launching duplicate model processes? |
| Presence and foreground use    | How should the existing presence implementation be packaged for standalone use? How should failed or disconnected instant requests affect the cooldown?                                                                                                            |
| Recurrence                     | How often is each agent due, how do we choose when several are due, and what happens to missed work after sleep or downtime?                                                                                                                                       |
| Agent definitions and tools    | What JSON schemas back the proposed agent commands? How should the chat client's skill/tool implementation be extracted, which read-only tools ship first, and what data may each read?                                                                                       |
| Memory and continuation        | How should follow-up chat handle long transcripts, edited prompts, or tools whose access was revoked?                                                                                                                                                              |
| Stopping and recovery          | What is the default per-agent active-time timeout, what counts as active time, and what checkpoints make interrupted-run resumption safe? Are additional turn, context, or repeated-call limits needed?                                                            |
| Storage and privacy            | What transcript format, access permissions, redaction, and retention rules preserve useful evidence without retaining secrets from tool output?                                                                                                                    |
| Result delivery                | Which lifecycle hook events and payloads ship first, and what timeout and delivery guarantees apply? How should an optional external hook promote findings to Proposals?                                                                                           |
| Distribution                   | Which platforms and runtime come first, and how will the owner install, start, or stop the daemon?                                                                                                                                                                 |

## Acceptance criteria for the proposed first slice

1. The owner can define two agents with distinct prompts, skills, and tool
   selections and inspect what each is allowed to do.
2. A check against a busy model starts nothing. A later eligible check starts
   one run, and a subsequent tick cannot duplicate an active run. A second
   managed agent cannot start while that run is active, even on another slot
   or model; a manual start or revival queues under the same rule.
3. An agent can read through an allowed tool and finish naturally. A request
   for an unselected or mutating tool is refused before execution.
4. The owner can find a finished run, read its result, and trace a finding to
   the tool response it used, all from the CLI.
5. A follow-up accepts new text and attachments on its user message, uses the
   selected run's history, and preserves its original answer. The next scheduled recurrence remains a separate run.
6. Restarting the daemon leaves the recorded exchange inspectable and never
   presents interrupted work as a natural completion.
7. With the executable and weights available but no server running, the first
   eligible request starts the server and receives a response. A later request
   for the same model reuses that process if it is still ready.
8. A local test client with no the chat client or the client application dependency can receive a
   streamed reply and continue the conversation after its cache is cleared.
9. If an interactive turn arrives during a background tool call, it can use
   the shared model before the background agent requests its next generation.
10. Guildscribe's bundled transcription hook can invoke a recoverable single-turn Granite
    agent run through the same Nightcrew service used for Qwen, and a fast Qwen
    request takes priority without either client starting another llama.cpp
    manager.

11. An instant request during background generation pauses that computation,
    receives its response, and leaves the background run paused throughout
    the configured cooldown. A follow-up resets the cooldown; expiry resumes
    the same run without duplicating committed messages or tool calls.

12. Background work starts or resumes only when the desktop is away and the
    instant cooldown has expired. Returning to the desktop pauses it.
13. A new run receives no prior conversation unless it explicitly loads one
    with an allowed tool. Restart recovery resumes the existing run instead
    of silently creating a fresh conversation.
14. Run timeouts produce a distinct inspectable outcome. Lifecycle hooks run
    after state is durable, and a hook failure does not erase the result.

15. An external supervisor can inspect run evidence and update an agent through
    the CLI without giving the worker write tools. A run records the effective
    configuration used.
16. Pausing and restarting a run preserve its consumed active-time budget;
    paused time never consumes the configured per-agent timeout.

17. Scoped help and schemas work offline. Inspection leaves run state unchanged;
    paginated search results identify the source run and matching events.
18. Export produces a consistent bundle at a new destination, and verification
    reports corruption without mutating its source.
19. Startup stop keeps the service stopped; restart preserves interrupted runs;
    uninstall preserves all runtime data.

20. A single-turn agent accepts invocation inputs and produces one completed
    response without executing tools. It uses the ordinary run status,
    transcript, cancellation, recovery, and hook surfaces; an interrupted
    attempt does not count as an extra completed turn.

## Standalone CLI and service implementation

Nightcrew is maintained directly through this specification and owner
instructions, without an application-specific planning system. The runtime command catalog and
request validators in `src/management.ts` now own implemented CLI discovery;
`nightcrew help` and `nightcrew schema get` expose them. Earlier proposed-command
tables describe future intent where a command is absent from that catalog.

The CLI manages a private local Unix socket while the daemon is running and
uses the same exclusive storage lock for offline configuration edits. This
local administrator interface is authorized by owner-only filesystem access;
it does not store a copy of the HTTP root token. `auth rotate --yes` can issue
a new HTTP root token through the local interface. The HTTP interface retains
its bearer-token authentication.

`src/startup.ts` owns the per-user `dev.nightcrew.daemon` LaunchAgent. Lifecycle
commands follow Guildscribe's names. Stop unloads registration from the active
launchd domain to suppress relaunch; start reloads the retained plist. Startup
configuration records an explicit PATH and absolute Node/CLI paths. Logs remain
under the runtime home, and uninstall preserves configuration and all run data.
The default runtime home is `~/.nightcrew`, optionally overridden by
`NIGHTCREW_HOME` or `--home`. No source checkout is used as runtime storage.

Agents, models, slots, skills and custom tools have CLI CRUD. Model creation
accepts initial slots atomically; existing references are validated before a
write. Bind/topology edits reject nonterminal work. Bind changes require daemon
restart. Agent revisions remain independent; model/slot edits use configuration
revision, while skill/tool definitions use content hashes for optimistic updates.

Custom tools may wrap built-in read-only adapters or invoke trusted external
executables. They require `readOnly: true`, an input JSON Schema, a bounded
timeout, JSON stdin/stdout and bounded output. This is a trusted-administrator
read-only contract, not OS-level enforcement of arbitrary executable behavior.
No shell interpolation or inherited secret environment is provided. The three
built-in adapters remain immutable and preserve same-agent history restrictions.

Run document version 2 adds `toolSnapshots`, capturing selected complete tool
definitions at run creation. Version 1 records remain readable; rewriting a
record upgrades its version. Edits to definitions affect new runs; removing a
tool removes its current execution permission. Skills remain Markdown and
custom tool definitions are validated JSON files under the private runtime home.

## Supervisor CLI contracts (implemented in 0.3.0)

The command registry in `src/commands.ts` owns parser metadata, scoped help,
dispatch, and request/result schema discovery. `src/protocol.ts` versions the
CLI envelopes and schema contract separately from the package. Failures report
stable codes, exit classes and explicit retry safety; timed-out mutations report
unknown outcomes. Versioned snapshots in `test/snapshots/versions` detect drift
and remain immutable. See the README for supervisor flags and exit classes.

Finite command deadlines cover input, IPC, subprocesses and readiness polling.
Accepted runs and hooks detach from command deadlines and retain their own
lifecycle limits. Diagnostics use stderr; finite result envelopes use stdout.
Capabilities distinguish implemented adapters from unverified model behavior.
Doctor performs read-only readiness checks, with an opt-in existing-daemon probe.
Package smoke tests exercise the packed, independently installed executable in
an isolated temporary home. A short Qwen/Granite switch is verified in `model-switch-verification.md`;
interruption and broader workloads remain to be verified before migrating the chat client.

## Slot snapshot lifecycle (implemented in 0.4.0)

Each model has `slotSnapshots: { enabled, directory }`, defaulting to disabled
and a null directory. Null resolves to `<home>/slots/<modelID>`; an absolute
custom base also receives a model-ID subdirectory. Runtime ownership remains
in `src/runtime.ts`. Snapshots save before switching, idle unloading and clean
shutdown, and restore after loading. Only one model is resident across a switch.

`slots save <slotID>` and `slots restore <slotID>` use the daemon, support dry
runs, and reject active/queued inference. Manual save requires a loaded model;
restore can provision it. Private files and atomic manifests preserve the last
committed snapshot. File/settings fingerprints reject incompatible snapshots.
Automatic cache misses fall back to transcript processing; explicit failures
are reported. See `model-switch-verification.md` for the verified short-text/synthetic-audio
round trip and the remaining performance and compatibility limits.

Agent generation settings (0.5.0): `thinking` defaults to true and
`maxOutputTokens` defaults to 4096 (1–32768). They are editable through agent
CRUD, captured in run snapshots and forwarded to runtime generation. Thinking
uses the llama.cpp chat-template option `enable_thinking`. Existing records
without these fields retain the previous default behavior.

Per-turn thinking (0.6.0): submitted user messages accept optional boolean
`thinking`, persisted alongside content and attachments. Each managed generation
uses the latest user message's override, falling back to the run's snapshotted
agent default. Tool-loop continuations keep that turn's setting; subsequent
user replies resolve independently. Reusing a message UUID with a different
thinking override is a conflict. Interactive chat honors the latest user
message's override, leaving the model template default when omitted.

Instant-agent scheduling (0.7.0): explicit runs and replies assigned to the instant
slot bypass desktop presence and cooldown. They preempt background managed runs
but never overlap model computation or preempt already-running instant work.
Queued instant chat takes precedence over queued instant agents; background runs
still require desktop-away and expired cooldown. Instant run submission and
completion refresh the persisted interaction cooldown. Automatic recurring
dispatch remains deferred and must not infer human presence from an agent's
slot assignment alone.

The package includes `examples/hello-world` as ordinary opt-in JSON requests and
Markdown instructions. `init` remains minimal and no example installation CLI
is introduced. Examples have automatic dispatch disabled; installation copies
become user-owned definitions.

Operational logging (0.8.0): `config.logging` sets level (`off`, `error`, `warn`,
`info`, `debug`), maximum bytes per log file, and total retained files. Defaults
are warn, 1048576 bytes, and three files. Logging-only changes apply live through
CLI config updates or HTTP config PATCH. The schema and allowlisted events/fields
are owned by `src/logging.ts`; see README for commands and retention semantics.

Logs are private bounded JSONL in `<home>/logs/daemon.jsonl`. They contain only
additional operational evidence, never duplicated transcript/state/configuration
payloads, per-run lifecycle or reconstructible metrics. Missing or incompatible
cache snapshots are silent. A 30-second event/identity suppression window and
bounded asynchronous queue prevent storms. Logger failures do not fail inference.
Finite CLI diagnostics and legacy launchd streams remain separate. This does not
introduce inference metrics or the chat client integration.

Transcription parity controls (0.9.0): agents configure temperature (0–2, default
0.7), preserved in run snapshots. The audio adapter forwards the latest user
message content as the optional transcription prompt, alongside the agent's
temperature and maxOutputTokens. Existing empty-content audio submissions remain
unprompted. Agent updates that omit temperature preserve the existing setting.
