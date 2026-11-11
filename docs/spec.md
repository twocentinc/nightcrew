# Nightcrew specification

Status: implemented contract through 0.18, with validation limits listed below.
Runtime schemas and registered procedures are authoritative; this document
explains behavior rather than maintaining another endpoint inventory.

## Purpose and boundaries

Nightcrew is a standalone CLI and daemon that owns local llama.cpp model serving,
interactive inference, and recurring background agents. It has no dependency on
the client application, the chat client, or Guildscribe. Clients submit requests; Nightcrew controls
model residency, physical slots, scheduling and durable agent transcripts.

The daemon resolves llama-server from PATH and provisions it on demand. Model
definitions reference existing weights and optional projector files. Nightcrew
does not implicitly download weights. One model is resident for background work;
model priorities, residency preference and wait aging avoid unnecessary swaps.

## Canonical contracts and transport

src/operations.ts defines the shared oRPC procedures, their output schemas and
command metadata; src/operationInputs.ts defines their input schemas. The CLI
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
routes in src/server.ts remain compatibility adapters, with their historical
envelopes and pagination; managed actions delegate to the shared procedures.
Streaming run/chat events remain dedicated oRPC routes.

Bootstrap, local service installation, startup logs, local inspection and schema
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
snapshots, and compactionThresholdTokens. Configuration schemas in src/contracts.ts,
src/scheduler.ts, src/triggers.ts and src/compaction.ts define limits and defaults.
Examples are opt-in files under examples; init does not install bespoke agents.

## On-demand skills

Skills are folders with SKILL.md and optional references/ and assets/ trees.
Each file is limited to 128 KB; a skill supports 64 files and 512 KB serialized
resource data. Text uses UTF-8, binary assets use base64. Paths cannot traverse
outside these directories or follow symlinks. Skill CRUD writes folders;
skills reload validates direct filesystem edits before adopting them.
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
resumption. Completed runs can receive replies. Run state and event history
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

To continue, raise the agent's limit where capacity permits, then explicitly
release the held queue entry. Release refreshes that limit and rejects a run
still over capacity. Exporting history does not free storage. At the maximum
limit the run stays held; automatic pruning or starting a replacement persistent
run is not implemented.

## Scheduling, triggers and interactive work

The queue is a view of run state and pending inputs. Trigger, queue and scheduler
commands operate on those resources. Timer triggers support fixed intervals and
cron; external scripts and HTTP callers submit ordinary agent runs. No separate
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
and its request/result schemas live in src/scheduler.ts.

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
targets reserve the retained context plus tokenizer slack; child output reservations
are capped to that target plus JSON overhead, within the configured output limit.

A summarizer executes as a separate linked fresh run with its own model, prompt
and output settings. The waiting parent consumes no active-time budget. Child work
uses ordinary scheduling safeguards and dependency priority; recursive compaction
is disallowed. A script receives the versioned request and returns a nonempty
summary JSON object. Both paths validate the resulting parent context before
committing and invalidate incompatible KV generations.

Missing handlers, invalid summaries, oversized retained input, or handler failure
hold the parent with context_full. Explicit queue release retries with the current
handler. Restart retains dependencies; cancellation cancels unfinished child work.
Instant request compaction and automatic multi-stage chunking remain deferred.

## Hooks

Configured notification events are run.completed, run.failed, run.timedOut,
run.cancelled and run.storageLimit. Each executable receives one JSON line on
stdin with version, event, runID, agentID, segment, state, result, error and
eventSequence. Storage-limit notifications additionally include storage with
limitMB, bytes and message/event/attempt counts captured at the boundary.

A storage hook runs after the hold is persisted and does not unpause the run.
It can notify a supervisor or use the CLI to export/review the run. Hook stdout
is ignored; it is not a summary protocol. Explicit queue release is still required.
One delivery attempt is recorded per event sequence and executable. Repeated
submissions to the same held run do not create new storage-limit events.
A later release and subsequent limit crossing can produce a new event.

Hooks have bounded time and minimal environment. Delivery receipts and results
are durable; uncertain in-flight deliveries after restart are marked unknown
and are not automatically retried. This is at-most-once attempted delivery, not
a guarantee of external side-effect completion. Scheduler and compaction hooks
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
is documented in live-validation.md and excluded from npm test. It was prepared
but not executed for this milestone. Remaining empirical work includes long-run
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
task review status, delivery and lifecycle-hook status, reasons and a next action.
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
      "properties": {"answer": {"type": "string"}},
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
Exhausted recovery remains visible as needsReview even if final formatting passes.

Compaction receives explicit instructions to separate facts, hypotheses, failed
attempts and remaining work. A deterministic source check rejects newly invented
numeric literals and evidence IDs before accepting a checkpoint. It does not
prove relationships, units or causal interpretations are correct, nor require
all source facts in a bounded summary. Exact source context remains recoverable;
a rejected checkpoint holds the parent at context_full. After compaction the
model receives authoritative Nightcrew tool counters and recovery state, instead
of relying on the summarizer's arithmetic. Existing checkpoints are not rewritten.

`fleet status` uses the same oRPC operation for CLI and HTTP and requires the
daemon for current runtime state. It shows each configured agent, its schedules,
latest run activity/outcome, active run count, review count and recorded active
milliseconds, plus current presence/cooldown, model/slot status and the newest
100 runs needing review. Totals cover all retained run summaries; active time
for persistent runs is the current segment's stored counter, not lifetime CPU
usage. No new index, queue database, or inferred memory/token telemetry is stored.
