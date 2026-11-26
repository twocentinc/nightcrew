# Nightcrew specification

Status: release 0.43.0, protocol 1, schema 44.
See [compatibility.md](compatibility.md) for stable surfaces and change policy.
Runtime schemas and registered procedures are authoritative; this document
explains behavior rather than maintaining another endpoint inventory.

Deferred exploration: [workspace pipelines](pipelines.md) describes a possible
future dependency-graph workflow. It is not part of the implemented contract or
approved implementation scope.

## Purpose and boundaries

Nightcrew is a standalone CLI and daemon that owns local llama.cpp model serving,
interactive inference, and recurring background agents. It has no dependency on
particular applications. Clients submit requests; Nightcrew controls
model residency, physical slots, scheduling and durable agent transcripts.

The daemon resolves llama-server from PATH and provisions it on demand. Model
definitions reference existing weights and optional projector files. Nightcrew
does not implicitly download weights. One model is resident for background work;
model priorities, residency preference and wait aging avoid unnecessary swaps.

## Source organization

`src/cli.ts` is the executable entry point. `commands/` has one module per
public command family and no shared helper modules. `utils/commands/` owns shared
procedure definitions, discovery, dispatch, request aggregation and resource
transactions. Shared types and validators live in `schemas/`; import
schemas directly from their owners rather than through re-export barrels.

`engine/service.ts` composes the components and retains the service-facing API.
Components declare narrow dependencies and keep their state with its owner.

| Folder/module                | Ownership                                                                                      |
| ---------------------------- | ---------------------------------------------------------------------------------------------- |
| `engine/runs/submissions.ts` | Submission, replies and persistent segments                                                    |
| `engine/runs/controls.ts`    | Pause, resume, cancellation, retries and capability refresh                                    |
| `engine/runs/triggers.ts`    | Trigger admission, deduplication and pending-input activation                                  |
| `engine/execution/`          | Runner, context, request, inference, response, tools, completion and bounded process execution |
| `engine/instant/`            | Request lifecycle and a separate interactive generation runner                                 |
| `engine/scheduling/`         | Dispatch, policy, schedule definitions and timer tracking                                      |
| `engine/models/runtime.ts`   | Model admission, switching and residency                                                       |
| `engine/models/server.ts`    | llama.cpp process startup, health and shutdown                                                 |
| `engine/models/client.ts`    | Generation and tokenization requests                                                           |
| `engine/models/stream.ts`    | Stream decoding, reasoning and tool-call assembly                                              |
| `engine/models/cache.ts`     | Slot ownership, snapshots, compatibility checks and pruning                                    |
| `engine/models/types.ts`     | Runtime adapter contracts                                                                      |
| `engine/compaction/`         | Coordinator, recovery, format and source evidence                                              |
| `engine/capabilities/`       | Tool registry, skill resources and bundled executable commands                                 |
| `engine/evals/`              | Definition edits, mock tools, and ordinary-run grading                                         |
| `schemas/`                   | Common primitives, agents, models, runs and configuration                                      |
| `storage/store.ts`           | Home lock, lifecycle and the shared transaction queue                                          |
| `storage/config.ts`          | Configuration initialization, validation and persistence                                       |
| `storage/transcript.ts`      | Run validation, transcript persistence and post-write index commits                            |
| `storage/files.ts`           | Atomic writes, file permissions and bounded reads                                              |
| `utils/json.ts`              | Canonical JSON serialization and compatible content fingerprints                               |
| `storage/runIndex.ts`        | Run discovery, reconciliation, message ownership and derived indexes                           |
| `storage/records.ts`         | Run projections, pagination, search and startup recovery                                       |
| `storage/artifacts.ts`       | Export bundles and integrity verification                                                      |
| `server/http.ts`             | HTTP/oRPC hosting, authentication and router mounting                                          |
| `server/resources.ts`        | Legacy HTTP resource adapters                                                                  |
| `server/streams.ts`          | Event-stream lifecycle and limits                                                              |

Smaller engine concerns remain in `configuration.ts`, `supervision.ts`,
`hooks.ts` and `protocol.ts`. Server control-socket, startup, diagnostics and
logging modules remain alongside HTTP hosting.

The runner calls tool recovery, completion validation, request preparation,
compaction, inference and response recording in order. Instant requests retain
their different tool permissions and persistence rules. Compaction yields through
dispatch instead of starting an independent scheduler.

Preserve storage-lock boundaries and durable write ordering across components.
Shutdown settles execution before closing the model runtime, drains hooks, then
closes storage. Startup recovery marks uncertain deliveries unknown instead of
replaying messages. Derived indexes change only after their durable writes commit.

Public npm exports remain `nightcrew` and `nightcrew/operations`. Internal file
paths are implementation details, not compatibility entry points.

Shared JSON canonicalization and fingerprints live in `src/utils/json.ts`.
Configuration response schemas live in `src/schemas/config.ts`; command resource
helpers own configuration-change admission policy. Bearer-token verification is
shared through `src/storage/config.ts`, while transports retain their error responses.
Transcript projections build per-call message and attempt indexes.

## Canonical contracts and transport

Each top-level command module in src/commands/ owns its input/output schemas,
metadata and handlers. src/utils/commands/definition.ts builds their shared oRPC
procedures; operations.ts and inputs.ts aggregate the family definitions. The CLI
takes request/result schemas directly from these procedures. Offline management
and the private daemon control socket execute the same procedures through oRPC.
The control socket remains local newline-delimited JSON; sharing contracts does
not require replacing that transport.

Remote management mounts each eligible procedure as POST
/v1/operations/<resource>/<action>. Requests contain request, optional resourceID,
and optional dryRun and yes flags. Omit resourceID for operations without an
operand. Authentication uses one global root bearer token. The token is hashed
at rest. Nightcrew binds loopback; exposing it remotely requires an explicitly
configured external transport. There are no per-client properties or grants.

TypeScript consumers may import the ManagementRouter type from
nightcrew/operations. OpenAPI is generated from the same router. Legacy resource
routes in src/server/http.ts remain compatibility adapters, with their historical
envelopes and pagination; managed actions delegate to the shared procedures.
Streaming run/chat events remain dedicated oRPC routes.

Bootstrap, local service installation, daemon logs, local inspection and schema
discovery remain CLI concerns. Run export and bundle verification require local
filesystem access and are not exposed as remote operations. Read the generated
command catalog or CLI help for the exact inventory.

Finite CLI commands emit one versioned JSON envelope, with diagnostics on stderr.
Unknown inputs are rejected. Mutations support dry runs where applicable.
Destructive operations require yes; dry runs do not. Configuration updates use
revision checks. Public config omits secrets, and legacy HTTP config also omits
model and hook executable paths.

## Configuration and resources

The default home is ~/.nightcrew. JSON configuration stores agents, models,
scheduler settings, hooks and triggers. Each run has its own state file;
configuration does not embed a growing run index. Startup reconstructs indexes
from run files and preserves healthy history if another run is malformed.

An agent selects a prompt, model, mode, skills, allowed tools, timeout, priority,
time slice, context policy, output limit, temperature, thinking default,
compaction handler and storage limit. Skills provide instructions, not additional
tool permissions. Tools are trusted administrator executables running with the local user’s
permissions. Nightcrew does not enforce read-only behavior or provide an OS sandbox.
Their input/output, deadlines, environment and process lifetime are bounded.

Every tool is executable-backed. executablePath is required; argv contains
string argument templates, while model-supplied structured JSON is validated
against parameters and sent on stdin. There is no adapter discriminator. Bundled
skill/history tools are ordinary executables. History wrappers call the CLI;
the skill helper receives selected snapshots over a private pipe. They receive non-secret home,
agent and run context through environment variables. Their checks are wrapper
behavior, not a restricted authorization boundary for custom executables.
Legacy adapter definitions remain readable through in-memory conversion.
Argv templates support %parameter% and dotted paths, with %% for a literal percent.
Validated strings are substituted unchanged; other JSON values become compact JSON
text within one argument. Missing parameters fail before launch. Each argument
retains its boundary, has a 4000-character expanded limit and rejects NUL.
Substitution is nonrecursive and does not invoke a shell. Structured input is
still supplied on stdin; arrays do not spread and optional flags are not omitted.

Models define chat or audio behavior, paths, idle unloading, priority, optional KV
snapshots, and compactionThresholdTokens. Configuration schemas in src/schemas/config.ts,
src/engine/scheduling/policy.ts, src/engine/scheduling/schedule.ts and src/engine/compaction/format.ts define limits and defaults.
Examples are opt-in files under examples; init does not install bespoke agents.

## On-demand skills

Skills are folders with SKILL.md and optional references/ and assets/ trees.
Each file is limited to 128 KB; a skill supports 64 files and 512 KB serialized
resource data. Text uses UTF-8, binary assets use base64. Paths cannot traverse
outside these directories or follow symlinks. Skill CRUD writes folders;
config reload validates direct filesystem edits before adopting them.
skills read returns instructions or selected files without modifying state.
Updates omitting files preserve resources; explicit files replace them.

Agent-loop runs automatically receive the executable load_skills tool. Only
configured skillIDs appear in the name/description catalog. Instructions and
individual resources enter model context on demand. Run snapshots preserve
admitted content through interruption and export; compaction retains the catalog.
Skills do not implicitly grant other tools or execute scripts.

Instant requests select their own skillIDs. Nightcrew automatically executes
load_skills calls and continues generation, bounded by the request deadline,
16 rounds and 4 MB generated messages. The 6 MB admission cap includes snapshots.
It never executes client-defined tools; mixed batches return only outstanding
client calls. Clients append the returned generated messages and their own tool
results to subsequent request history. Selected instant snapshots remain ephemeral.
Single-turn agents retain their existing tool-free contract.

## Runs and messages

A fresh agent starts a new run with its system prompt. A persistent agent retains
one run ID and full transcript across invocations. Each invocation has a segment
and active-time budget. Replies and timer submissions enter that same durable
history; pending inputs are recorded rather than stored in a separate queue DB.

Clients generate message UUIDs. Retries reuse the UUID and identical payload;
conflicting reuse is rejected. Attachments belong to each message, including
later turns. There are no submission receipts or persisted interactive requests.
Hook delivery receipts remain necessary to record external delivery attempts.

Single-turn agents finish after one model response. Agent-loop agents execute
allowed tool calls until a final response or limit. Active time counts against
the agent timeout; paused time does not. Interruption preserves the run for
resumption. Completed and cancelled runs can receive replies. A reply to a
cancelled run starts a new segment in the same transcript, clears its scheduling
hold, and does not resume the cancelled turn or its pending inputs. Failed and
timed-out fresh runs still require explicit recovery. Run state and event history
remain authoritative over daemon logs.

Thinking can be overridden on each user turn; omission uses the agent default.
Successful assistant messages store the effective thinking flag and, when enabled,
the separate reasoning trace. Attempts persist partial text, reasoning and tool
fragments before a generation commits. Failure, cancellation, preemption and
restart preserve available evidence and its outcome. A process crash can lose
deltas after the most recent checkpoint.

Attempts appear in transcript reads, exports and searches. Agents with the
runs_transcript tool can inspect their own failed attempts. Unfinished text is
not automatically inserted as a completed assistant message; partial tool calls
are never executed. A successful attempt references its committed message instead
of duplicating the payload.

## Transcript storage limits

Each agent has storageLimitMB (default 48, range 1–48). This measures serialized
run state, including messages, attachments, events and attempts, rather than model
tokens. Reaching it holds the run with storage_limit. New submissions are rejected
while held. The same run ID and existing history remain intact.

The limit is checked at execution/admission boundaries, so the final operation
can exceed the configured threshold. Message/event/attempt admission ceilings
also pause growth; the underlying state-file hard limit retains reserved space.
No automatic transcript deletion, splitting, or archive rotation is performed.
Compaction does not reduce transcript storage.

For a byte limit, raise the agent's storageLimitMB where capacity permits, then explicitly
release the held queue entry. Count limits identify the exhausted collection and
require a new run; increasing MB cannot resolve them. Release refreshes that limit and rejects a run
still over capacity. Exporting history does not free storage. At the maximum
limit the run stays held; automatic pruning or starting a replacement persistent
run is not implemented.

## Scheduling, triggers and interactive work

The queue is a view of run state and pending inputs. Trigger, queue and scheduler
commands operate on those resources. Timer triggers support fixed intervals and
cron using cron-parser syntax and timezone/DST behavior; external scripts and HTTP callers submit ordinary agent runs. No separate
polling-script trigger is required: an agent can begin with a tool and finish
quickly when there is no work.

Missed timer occurrences are skipped, never replayed. The live daemon tolerates
five seconds of ordinary dispatch delay. Trigger queue policies choose skip,
enqueue or coalesce. Disabling timers does not erase history.

Background work requires the desktop to be away and the interaction cooldown to
have expired. Presence reuses the existing native idle-time approach. Unhealthy
presence blocks background admission. Instant inference bypasses these gates,
preempts background compute, and extends interactionCooldownMs (default five
minutes). Only after cooldown and away status can background work resume.

scheduler.instantModelID selects the interactive model. By default one background
slot and one instant slot exist for that model. maxConcurrent defaults to one;
additional background capacity is opt-in. Physical slots are scheduler allocations,
not permanent public resources. Fresh contexts clear on takeover. Persistent
contexts can restore agent-owned checkpoints into a borrowed slot. Missing or
incompatible checkpoints fall back to transcript reconstruction.

The default scheduler favors eligible higher-priority work, resident models,
minimum residency and aging. A bounded external scheduler hook may propose
starts and pauses. Nightcrew revalidates every plan against presence, cooldown,
model compatibility, slot ownership, dependency and capacity constraints.
Failure policy chooses built-in fallback or hold. Scheduler hook configuration
and its request/result schemas live in src/engine/scheduling/policy.ts.

KV snapshots are disposable acceleration data. They are not authoritative run
history. Model snapshot settings choose whether/where to save them; the default
directory is under the Nightcrew home. The scheduler bounds snapshot disk usage.
Agent cache inspection/reset replaces top-level physical slot management.

## Context compaction

Context pressure and transcript storage are independent. Before generation,
Nightcrew counts templated input tokens and reserves the configured output budget.
The model's compactionThresholdTokens may trigger compaction earlier. Context
shifting is disabled.

An agent can select a script handler or a single-turn summarizer agent.
Compaction preserves the parent run and original messages. A checkpoint stores
the summary, inclusive coverage boundary, token counts and optional child run ID.
Coverage ends at a complete turn/tool-exchange boundary. Later model input consists
of instructions, the summary and remaining messages. Handler requests exclude stored
thinking traces, decode text attachments, and identify omitted binary attachments
without sending base64. Original transcript evidence remains unchanged. Summary
targets are capped at 4096 tokens and one third of the trigger threshold, and
reserve the retained context plus tokenizer slack. There is no fixed word cap; child output reservations
are capped to that target plus JSON overhead when thinking is disabled. Thinking-enabled
children retain their configured generation limit because reasoning shares that
budget with the visible summary. Both reservations must fit the child context;
the final summary still obeys the smaller summary target. Thinking in linked
compactors is limited to half the generation budget, capped at 1024 tokens, to
reserve room for the visible answer.

A summarizer executes as a separate linked fresh run with its own model, prompt
and output settings. The waiting parent consumes no active-time budget. Child work
uses ordinary scheduling safeguards and dependency priority; a same-model
compactor for an interactive parent inherits its instant slot and interactive
admission so it does not wait for desktop-away eligibility. Recursive compaction
is disallowed. A script receives the versioned request and returns a nonempty
summary JSON object. Both paths validate the resulting parent context before
committing and invalidate incompatible KV generations.

Agent summary failures get up to compaction.maxRetries retries (default 1, range
0–2), each preserving the summary token target and creating a new linked child run. Prior
children and failure events remain durable across restart. Script handlers do not
automatically retry. Missing handlers, oversized retained input, or exhausted
summary retries hold the parent with context_full. Context preparation/runtime
errors instead hold at runtime_error with their actual error; resuming the parent
releases its blocked compactor without consuming a summary retry. Explicit runs resume retries with the current
handler. Restart retains dependencies; cancellation cancels unfinished child work.
Instant request compaction and automatic multi-stage chunking remain deferred.

## Hooks

Configured notification events are run.completed, run.failed, run.timedOut,
run.cancelled and run.storageLimit. Each executable receives one JSON line on
stdin with version, event, runID, agentID, segment, state, result, error and
eventSequence, eventID, hookID and receiptID. Storage-limit notifications
additionally include storage.previousState and storage.limit with resource, used
and maximum captured at the boundary.

A storage hook runs after the hold is persisted and does not unpause the run.
It can notify a supervisor or use the CLI to export/review the run. Hook stdout
is ignored; it is not a summary protocol. Explicit runs resume is still required.
Each configured hook has a stable hookID. One automatic delivery attempt is
recorded per eventID and hookID;
explicit supervisor retries append linked receipts without replacing old ones. Repeated
submissions to the same held run do not create new storage-limit events.
A later release and subsequent limit crossing can produce a new event.

Hooks have bounded time and minimal environment. Delivery receipts and results
are durable; uncertain in-flight deliveries after restart are marked unknown
and are not automatically retried. Automatic dispatch is at-most-once attempted delivery, not a guarantee of external
side-effect completion. Explicit retries can repeat side effects. Scheduler and compaction hooks
have their separate typed request/result protocols described above.

## Operations and validation

The daemon and per-user macOS LaunchAgent have separate lifecycle commands.
Uninstalling the service does not delete configuration, runs or models.
Operational JSONL logs are optional and severity-filtered, rotated and bounded.
They record only additional Nightcrew diagnostics, not prompts, responses,
tool output or lifecycle facts already reconstructible from run state.

Run export creates a new immutable bundle with checksums, configuration snapshots,
transcript, results and attachment evidence. Verification is read-only and checks
schema, identity, event order, references and bundle consistency. It never invokes
models or tools.

Normal tests use mock inference and temporary homes. The opt-in real-model suite
is documented in live-validation.md and excluded from npm test. Controlled real-model acceptance passed on November 16 with a resumed audio
fixture, as recorded in [acceptance.md](acceptance.md). This was not a clean
uninterrupted overnight soak or abrupt-crash test. Remaining empirical work includes long-run
storage growth, preemption latency, residency/concurrency memory use, and summary
quality. No UI, automatic transcript pruning, distributed scheduling or per-client
authorization is promised by this contract.

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

## Bounded worker history and compaction recovery

The bundled runs_list tool returns prior terminal runs newest first, excluding
its current run. runs_transcript rejects reads of the current nonterminal run,
limits long string fields to 2000 characters with explicit truncation markers,
and bounds each page to approximately 12000 characters. A budget-limited page
includes nextOffset for continuation. Full transcripts remain available through
the administrator CLI. These limits prevent recursive conversation duplication.

Compaction accepts additional JSON metadata alongside a nonempty string summary;
only the validated summary is used. Missing, empty, non-string or oversized
summaries remain invalid. Skill guidance distinguishes the skillIDs instruction
request from files requests, which must use actual manifest resource paths.

Compaction also normalizes a JSON string or an exact fenced JSON value before
validating the summary. Arbitrary prose is not extracted as JSON. Invalid tool arguments return bounded schema-validation details so
the model can correct fields and enum values without guessing.

## Agent sampling controls

Agents optionally configure `sampling` with `topP` (0–1), `topK` (integer 0–1000),
`minP` (0–1), `presencePenalty` (-2–2), `repeatPenalty` (0–2), and
`parallelToolCalls` (boolean). Omitted values retain the backend defaults.
Settings are captured in the run snapshot and forwarded to llama.cpp;
`parallelToolCalls` also participates in template token counting. These controls
apply to chat-agent inference, not audio models or client-owned instant requests. Temperature
remains the existing separate agent property. Schema version 25 adds these
optional controls without changing existing agent defaults.

Agents may also set `maxToolCalls` (1–1000, omitted means no tool-call cap).
It counts attempted calls since the latest user message, including builtin tools
and invalid calls, and survives pauses/restarts in the transcript. Excess calls
in a batch receive a nonfatal `tool_budget_exhausted` result without execution.
After the budget, the next generation has no tools, explicit `tool_choice: none`,
and an execution-limit instruction to answer from existing evidence. The limit
resets on a new user turn. It does not discard evidence or bypass timeouts.

Tool-budget finalization disables thinking so the remaining output budget is
available for the visible answer. An agent-loop response with no tools and an
empty visible answer receives one tool-free, thinking-disabled finalization
attempt. If that is also empty, the run fails explicitly instead of completing
with an empty report. Thinking remains in the transcript as evidence; it is never
promoted into the final answer. Single-turn/audio behavior is unchanged.

## Supervision and outcome reporting

`runs get` and run summaries expose `outcome`: execution state, output validation,
derived task status, delivery and lifecycle-hook status, reasons and a next action.
Execution `completed` means generation ended; it does not mean the answer is
correct or delivered. Without a validator the task is `unverified`. `validated`
means only the configured validator passed. Failed execution, invalid output,
exhausted recovery, failed/uncertain hooks, and context/storage holds need review.
Historical runs are not retroactively validated. Persistent runs report the
current segment; prior validation records and hook receipts remain inspectable.

Agents may configure `outputValidation` (null by default):

```json
{
  "validator": {
    "type": "json-schema",
    "schema": {
      "type": "object",
      "properties": { "answer": { "type": "string" } },
      "required": ["answer"],
      "additionalProperties": false
    }
  },
  "repairAttempts": 1
}
```

Alternatively the validator is `{type:"hook", executablePath, argv, timeoutMs}`.
It is a trusted, side-effect-free executable using the existing bounded tool
runner. JSON stdin contains runID, segment and text; stdout must be
`{"valid":true,"reason":"what was checked"}` (or valid:false). It gets the
normal limited tool environment, no shell, at most 1 MB stdout, and a bounded
100–60000 ms deadline. Infrastructure errors do not trigger model repair or
automatic hook retries. Interrupted checks can execute again on resume, so the
validator must not deliver messages or mutate external state.

Invalid output allows zero to two repair completions (default one), without
tools or thinking. Originals and verdicts stay in the transcript/state; limits
survive restart and reset per persistent segment. Validation errors are not
promoted to factual claims. Repair instructions and output schemas survive
context replacement. Lifecycle delivery hooks have explicit `purpose:delivery`;
other/legacy hooks default to notification. Delivery hooks are not dispatched
when configured output validation failed or errored. Unknown delivery after a
restart is never blindly retried. Hook success denotes successful hook execution,
not independently confirmed receipt by an external recipient.

`loopPolicy` defaults to consecutiveErrors:3 and repeatedCalls:3. Nightcrew
examines committed tool results, including tools returning ok:false with exit
zero. Repeated unchanged requests, consecutive errors and exhausted tool budgets
trigger a recorded recovery opportunity. A further tool failure or repeated loop
ends tool use and requests a constrained final answer. The global tool limit
also forces finalization. No hidden retry re-executes a failed external action.
Exhausted recovery remains visible as needsAttention even if final formatting passes.

Compaction receives explicit instructions to separate facts, hypotheses, failed
attempts and remaining work. A deterministic source check warns about unsupported
numeric literals and evidence IDs. Warnings are retained in the `compacted` event
and do not block accepting a checkpoint. Numeric comparisons
ignore valid thousands separators and trailing decimal zeros, and permit rounded
displays of source decimal quantities. Rounding uses exact integer arithmetic and
never rounds integer identifiers or converts values to percentages. Count-pair
notation such as scanned/total is accepted only when both components exist in
the source; this does not validate their relationship. Timestamp
formatting and list ordinals are checked separately. This lexical check does not
prove relationships, units or causal interpretations are correct, nor require
all source facts in a bounded summary. Exact source context remains recoverable;
Only invalid/empty summaries, generation failures, or context-size failures can
hold compaction; evidence discrepancies do not trigger retries or holds. After compaction the
model receives authoritative Nightcrew tool counters and recovery state, instead
of relying on the summarizer's arithmetic. Existing checkpoints are not rewritten.

`status` uses the same oRPC operation for CLI and HTTP and requires the
daemon for current runtime state. It shows each configured agent, its schedules,
latest run activity/outcome, active run count, attention count and recorded active
milliseconds, plus current presence/cooldown, model/slot status and the newest
100 runs needing attention. Totals cover all retained run summaries; active time
for persistent runs is the current segment's stored counter, not lifetime CPU
usage. No new index, queue database, or inferred memory/token telemetry is stored.

Context preparation failures (template rendering, tokenization or unavailable
runtime) hold a run with `runtime_error` and `context_preparation_failed`, rather
than claiming its context is full. HTTP failures retain the endpoint, status and
bounded response body in run evidence, not daemon logs. Explicit runs resume
clears the hold after the underlying cause is corrected. Output-schema guidance
is merged into the leading system prompt, including when compaction rebuilds the
context; model templates need not support later system messages.

## Supervisor review and recovery

`runs resume` shares runs resume semantics. `runs retry` takes expectedRevision,
a new client messageID UUID and note; it requires a terminal non-compactor run
without pending inputs and repeats the last user input, attachments and thinking
override in a new segment of the same transcript. It uses ordinary reply snapshot
rules. Previous messages and attempts remain visible. Retry requires explicit confirmation (`--yes` in CLI); mutations support dry-run.

## Optional review agents

The distributed examples include a portable agent-supervisor with an executable
read-only run inspector, companion skill, manual trigger and Markdown completion
hook. It reports computed run metrics and bounded operational failure evidence for
a larger model to evaluate; it has no management or delivery tools. It snapshots
eligible revisions, discloses coverage limits and checkpoints only metric pages
returned before a successfully exported report. Checkpointing is not a factual
review guarantee. Nothing is activated by init; users install and configure the
example with the existing CLI. Its scripts use only Node APIs and the Nightcrew
home, without application dependencies.

The supervisor example is manual-only by default and emits local Markdown.
See examples/agent-supervisor for installation and scope. Installed copies are
not overwritten by package updates. Application-specific agents live externally.

### Source-linked compaction evidence

Compaction annotates user/tool content with stable, code-generated `src:` references.
Structured JSON leaf records and plain-text paragraphs are supported without
domain field names; system prompts, thinking and binary attachments are not sources.
The summarizer retains references beside factual claims, questions and decisions.
When rebuilding context, Nightcrew resolves those references against the original
covered transcript and includes original record/text content with its message ID
and JSON pointer or paragraph position. Source text remains untrusted data.

The evidence packet is bounded to 6000 serialized characters; whole excerpts that
do not fit and unknown references are explicitly listed as omitted. It does not
truncate a record into an apparently complete fact, fetch new data, or treat a
reference as proof of an interpretation. Sources are derived, not duplicated in a
new store; references carried through successive summaries resolve to the original
transcript. Existing summaries without source references remain supported. The
normal token counter still checks the complete summary plus evidence context.
This improves evidence availability, not summary accuracy or semantic verification.

### Managed response continuation

A managed agent's `maxOutputTokens` limits each generation, not the assembled
answer. A complete llama.cpp stream ending with `finish_reason: length` saves
its partial text/thinking/tool fragments in an attempt with reason `output_limit`
and requests continuation. Text uses llama.cpp native assistant prefill (`continue_final_message: "content"`) with the exact saved prefix as the final assistant message and no generation prompt. Token counting uses the same template options. Text chunks are appended verbatim and committed as
one assistant message only after generation stops normally. JSON validation and
completion/delivery hooks run on the assembled answer, never on a partial chunk.

Continuation is derived from unresolved attempts in the current segment and
survives daemon restarts, preemption, and compaction. Saved response text is kept
outside the compactor's source history and reinjected exactly, subject to actual
context counting and output reservation. Incomplete tool calls are never executed;
the next generation must emit complete calls from scratch. Thinking-only limits
retain the reasoning draft and request an answer with thinking disabled.

Active-time, context, transcript-storage and 1 MB assembled-response limits still
apply; an empty length response fails rather than spinning. Transport truncation
without a valid completed stream remains an error. Instant API requests and raw
instant requests keep their existing behavior; continuation belongs to managed runs, including eval runs.
A fresh run snapshots its generation limit and scheduling slice, so configuration
changes require a new fresh run; retry preserves that original agent snapshot.

### Evidence and worker review refinements

Compaction source packets retain bounded ancestor scalar metadata with each
original excerpt, preserving schema names, units, citation identity and scope
without domain-specific compactor rules.

Supervisor metrics distinguish normal compaction waiting from held runs and flag
empty structured result collections for review. Such flags are advisory, not
execution failures; bounded final-report excerpts allow review of useful output
separately from successful execution. Factual support still requires source review.

Compactor input admission counts the fully annotated, serialized request using the
compactor's model and reserved output budget. Oversized requests are partitioned
at complete exchange boundaries. Each accepted prefix checkpoint advances only
through messages actually summarized; the parent repeats compaction if its
remaining context is still over threshold. Original transcript messages remain
intact. A single exchange that cannot fit is held with an explicit diagnostic;
it is never silently truncated or recursively compacted by the child.

## CLI simplification, schema 31

The schema 31 simplification removed superseded names without aliases.
The compatibility freeze, including approved schema 41 parser semantics, governs further changes. Public
commands use `instant` for interactive requests and `daemon` for LaunchAgent
management plus foreground execution. `status` includes fleet/runtime/presence;
`--details` includes scheduling. `daemon status` reports local service installation.
Queue inspection uses filtered runs. `runs pause` holds queued work or interrupts
active work with a durable hold; `runs resume` releases it. Agent/trigger updates
own `enabled`; config updates own partial scheduler settings. Skill/tool CRUD
refreshes registrations; explicit reload remains advanced. Eval sampling and
release are internal-only, excluded from public CLI and HTTP discovery. Advanced
help exposes recovery, cache, schema, verification and diagnostic operations.

## CLI and HTTP surface (schema 32)

Cache inspection is part of `agents get`; saved cache removal is
`agents cache delete`. Root token rotation is `config token rotate`. Command words use spaces rather than hyphens.
The boolean config field `httpEnabled` defaults to true. Setting it false and
restarting disables the HTTP listener, while local CLI control remains available.
The replaced names remain absent; the freeze protects the current names.

## CLI observation and discovery (schema 33)

Root help exposes a compact command tree; exact command help adds metadata.
Model capabilities belong to `models get` and the aggregate `status --doctor` report.
`config reload` adopts skill/tool filesystem edits. Removed commands and flags
have no aliases: use `--verbosity` and `--no-input`.

`agents run --wait` and `instant create --wait` submit once, then poll the shared
get procedures until terminal. They compose the existing acceptance and detail
result contracts. They never cancel daemon work on timeout or signal, and errors
after acceptance include the accepted resource ID. Scheduling remains unchanged.

`runs transcript --tail` follows committed event sequences. Its shared request
supports `recent` or `afterSequence` without snapshot pagination cursors.
`daemon logs --tail` follows active files by byte offset and handles rotation,
truncation and incomplete UTF-8 lines. Tail output is JSONL using normal envelopes.
Waits default to 120 minutes; tails have no default deadline. Both accept explicit
observation timeouts up to 1440 minutes. Neither changes agent execution timeouts.

### Explicit instant model unloading

`nightcrew models unload` cancels accepted nonterminal instant requests and
interactive runs for the configured instant model, waits for their computation
to settle, and releases the resident model regardless of its idle/keep-warm timer.
It preserves transcripts and configuration; the next explicit message can
continue the same daily run and reload the model. Dry-run changes nothing;
repeating the command with no resident model or instant work is a no-op.
It refuses while unrelated background work uses that model. Normal background
scheduling remains enabled and may load a model again when eligible. It never
unloads a different resident model or restarts the daemon. The shared management
operation also exposes this behavior to authenticated HTTP clients.

### Measured run context usage

Run details include a nullable `contextUsage` snapshot: inputTokens, outputTokens,
capacityTokens, measuredAt and segment. Prompt preparation records the actual
templated token count including tool definitions, system/skill instructions and
retained context; accepted compaction replaces it with the reduced prompt count.
Generation completion records that inference's reported input/output usage, not
a cumulative daily total. During generation the last measured prompt count stays
visible; streamed text is not heuristically tokenized. Snapshots survive restart
and unloading. Older runs remain null until their next measured inference; reads
do not load a model merely to fill the counter. This is the latest evaluated
context, not a claim that model memory remains resident after unloading.

### Explicit capability refresh

`runs refresh RUN_ID` accepts `expectedRevision` and applies the
agent's current tool/skill definitions to a terminal run with no pending input.
It never submits a message or changes the run's model, prompt, history, state,
or scheduling. Prior tool/skill snapshots are retained in `capabilityRefreshes`
for audit; the previous token measurement is invalidated. Dry-run does not write,
revision conflicts reject, and active runs cannot be refreshed. This is an
explicit supervisor operation; ordinary fresh-run replies still retain their
configured capability list.

### Schema-validated completion

Agents may opt in with `finishSchema`, an object JSON Schema (default `null`).
Nightcrew exposes a special `finish` tool whose arguments are the final result.
It is not an executable tool and must not appear in `toolIDs`. A single-turn
agent can use this signal while remaining free of executable tools. Existing
agents without a finish schema keep their current completion behavior.

A finish call must be alone in its response: mixed batches receive errors and
none of their calls execute. Valid arguments become the serialized JSON run
result. Receipt, result and completion commit together. Ordinary text or invalid
finish calls cannot complete the run; three unsuccessful completion attempts
fail it. Ordinary executable-tool budgets exclude finish, which remains available
when the budget is exhausted. Existing output validation still applies to the
candidate result; normal lifecycle delivery remains separate from finish.
Configuration and resumed runs retain the snapshotted schema.

Structured compaction uses four arrays: `objective`, `decisions`, `findings`,
`nextActions`. Each bullet has `text` and `sources` (original `src:` references).
The compactor calls finish with this object. Checkpoints retain the original
structured result; resumed context receives section headings and Markdown text
bullets, without source references or restored evidence excerpts. Subsequent
compactors receive previous structured metadata. Unknown source references reject
the summary before checkpoint adoption; existing bounded compaction retries
apply. Legacy summary objects and checkpoints remain readable.

Schema validity and resolvable references do not prove factual accuracy or that
a particular source supports a claim. The compactor prompt preserves goals,
explicit decisions, observed findings and committed unfinished work, and forbids
inventing recommendations or promoting hypotheses into facts.

### Duplicate keys and supervisor coverage

Structured finish arguments and JSON-schema-validated output reject duplicate
object keys, including escaped spellings of the same key. They return repair
guidance instead of silently accepting the last value. Separate objects may
reuse field names. The original model response stays in the transcript.

The portable supervisor repeats a frozen priority-incident list in each tool
response. Its validator and exporter require explicit sections for each recent
failed, held or undelivered run before publishing or advancing its checkpoint.
Historical capability refreshes alone do not create incidents. Coverage checks
do not establish factual accuracy, and recovered child failures must be described
using their parent relationship evidence.

## Evals (0.43.0, schema 44)

- Saved eval definitions create ordinary runs with a seeded transcript and exact/default tool responses.
- The real agent finish contract, validation/repair, model choice, scheduler, interruption recovery and compaction remain active. Eval caches and run IDs are isolated; lifecycle delivery hooks are suppressed.
- Hidden grading first checks an optional expected JSON Schema, then an optional executable. Schema failure skips the executable. No grader means ungraded; grading never sends repair feedback to the agent.
- `evals` provides CRUD/run operations, `tools list/set/delete`, and `transcript get/set/append/update/delete/clear`. Shared oRPC contracts power HTTP, control socket and CLI.
- See [the eval format](eval-format.md) for definition fields, executable protocol, CLI examples, and recovery semantics.

## CLI simplification (schema 42)

Use `status --doctor` for configuration, executable, presence and live daemon checks. Online CLI calls the shared daemon operation; unavailable control sockets fall back to read-only local diagnostics. Plain `status` stays a fast runtime overview. Both expose the shared status request/result contract.

Instant inference uses `instant create`, `instant get`, and `instant delete`. Delete first settles cancellation, then forgets the request and result. `models unload` retains the guarded instant-model unload behavior and takes no operand. `agents cache delete` removes saved KV only; `runs refresh` adopts current capabilities in a terminal run.

There is no manual annotation/review workflow or public hook retry command. Run outcomes retain execution, validation and delivery evidence; `needsAttention`, status `issues` and `issuesTruncated` are derived rather than manually acknowledged.

## Run records (schema 43)

- One state.json per run remains the durable source. No transcript split or
  separate run database is introduced. Stored version is 3.
- `execution` replaces state, held, pauseReason and error at the top level:
  queued/running/completed carry only state; failed/cancelled/timedOut may carry
  error; paused carries reason and resume (`automatic` or `manual`), optional
  error, and limit evidence when reason is storage_limit. Context/runtime/storage
  errors and manualStop require manual resumption.
- Messages, attempts and events remain separate evidence collections. Every event
  has eventID, sequence, timestamp, segment and a validated type-specific payload.
  Sequence remains the transcript cursor; stable IDs link receipts to events.
- Receipts have stable IDs and retryOfReceiptID links, start/finish timestamps,
  status and diagnostics. Historical missing timestamps and ambiguous hook-result
  receipt links remain null. Internal explicit retry logic uses IDs; no public
  hook retry command is restored.
- Configured tools and all run tool snapshots use the same typed executable schema.
  Persistence validates event/receipt uniqueness and reference integrity.
- The scheduler retains a mutable internal working representation until an atomic
  commit; CLI/HTTP and files expose only the discriminated execution record.
