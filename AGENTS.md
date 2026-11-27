# Nightcrew

Nightcrew is a standalone local agent orchestrator. Use its
[specification](https://oss.twocents.com/docs/nightcrew/specification/) and the
owner's direct instructions for planning and implementation. Keep application integrations and
their executable tools outside this repository.

`src/commands/` contains only one module per top-level CLI command; do not add
shared helpers or aggregate modules there. Each family owns its
request/result schemas, metadata and handlers; local-only families register their
commands there too. Shared infrastructure lives in `src/utils/commands/`: `definition.ts` builds shared authenticated oRPC procedures and typed CLI flag bindings;
`operations.ts` aggregates them and `inputs.ts` aggregates their request schemas.
CLI, control socket and HTTP must invoke those same procedures. Dynamic command dispatch uses schema-inferred requests through `parseOperation`; keep command/request correlation at that checked boundary instead of handwriting request casts. `registry.ts`
owns discovery, registration and offline dispatch. `resources.ts` owns shared
atomic resource transactions; resource-specific mutations stay in family modules.
`src/engine/protocol.ts` owns versioned envelopes, errors and request validation.
`src/cli.ts` owns parsing and finite command execution; `src/engine/execution/process.ts` owns
shared deadlines, diagnostics, and the owner-pipe process guard used for llama.cpp
tools and script hooks. Owner death must terminate their process groups, while
uncertain delivery receipts remain non-retryable without review. `src/server/daemon.ts` owns the private control socket. `src/server/http.ts` owns
HTTP/oRPC hosting, authentication and router mounting; it must not own scheduling or agent
execution. `src/schemas/` owns shared schemas: common primitives, agents, models, runs and
configuration. Import each schema from its owning module; do not add barrel
exports or duplicate schema definitions. `src/engine/` owns execution and domain behavior; `src/storage/` owns
durable state, transcripts and run artifacts.
Shared JSON canonicalization and fingerprints live in `src/utils/json.ts`.
Configuration response schemas live in `src/schemas/config.ts`; command resource
helpers own configuration-change admission policy. Bearer-token verification is
shared through `src/storage/config.ts`, while transports retain their error responses.
Transcript projections build per-call message and attempt indexes.

`src/utils/commands/management.ts` dispatches internal management calls to command families.
`src/engine/scheduling/schedule.ts` owns schedule validation and next-occurrence calculation.
`src/engine/scheduling/policy.ts` owns live-slot derivation, policy configuration, default planning
and bounded external policy hooks. `src/engine/service.ts` composes the engine and
keeps the shared service-facing API, initialization and shutdown order. Components
receive explicit, narrow dependencies, never the entire Service.
`src/engine/scheduling/dispatch.ts` owns active executions, cancellation handles, timer
admission, plan revalidation, presence and interaction cooldown.
`src/engine/runs/submissions.ts` owns submissions and persistent turns;
`controls.ts` owns administrative transitions and `triggers.ts` owns trigger
admission, deduplication and pending-input activation. `src/engine/execution/runner.ts` owns background
execution order and live runs. Its step modules receive explicit dependencies:
`src/engine/execution/request.ts` builds model inputs, instructions and sampling settings;
`src/engine/execution/inference.ts` records attempts and captures generation evidence, and
owns the streaming buffer shared with instant requests;
`src/engine/execution/response.ts` assembles continuations and commits model responses;
`src/engine/execution/tools.ts` recovers pending calls and commits paired tool results;
`src/engine/execution/completion.ts` validates final output and settles interruption and
completion. Preserve the order of durable attempt, tool-result and message writes.
`src/engine/instant/requests.ts` owns instant request state and deadlines;
`runner.ts` owns generation and settlement.
`src/engine/execution/context.ts` owns model-visible history projection, skill catalog
injection and transcript storage-limit checks. `src/engine/compaction/coordinator.ts` owns
token budgets and linked compactor admission; `recovery.ts` owns checkpoint
reconciliation and retries. `src/engine/hooks.ts` owns delivery tasks, durable
receipts and draining on shutdown. Recorded invocations are never retried.
`src/storage/records.ts` owns run projections, pagination snapshots, search,
event/save helpers and interrupted-run recovery inside the startup transaction.
`src/engine/configuration.ts` owns shared agent/configuration validation and
mutation; `src/engine/models/types.ts` owns the runtime adapter interfaces.
`src/engine/compaction/format.ts` owns compaction schemas, summary parsing and
bounded script execution; `evidence.ts` owns source references and evidence
validation. It generates domain-independent source
references for original records/text excerpts and restores selected evidence into
legacy resumed context; structured summaries retain source references only as checkpoint metadata and inject Markdown bullets. Summaries never own source identity or wording. The compaction component schedules linked compactor
runs; the runtime counts templated tokens and validates KV checkpoint generations.
Managed output-limit continuation is reconstructed from durable attempt records;
never validate/deliver partial answers or execute truncated tool calls.
Persisted runs use one discriminated `execution` record; mutable engine working state is encoded and validated at storage boundaries. `src/schemas/execution.ts`, `event.ts`, `hook.ts`, and `tool.ts` own the shared typed contracts. Hook identity never depends on executable paths or array positions. Hook retries are removed; never replay a recorded invocation. Runs carry pending inputs, compaction checkpoints, configuration and trigger occurrence snapshots.
`src/engine/supervision.ts` owns output-validation configuration/execution, loop detection
and derived run outcomes, hook receipt outcomes. Keep validation evidence durable and never equate schema
validation or hook execution with factual correctness or confirmed external delivery.
`src/engine/evals/format.ts` owns eval definitions and grading schemas;
`definitions.ts` owns tool/transcript edits, `tools.ts` substitutes tool results,
and `results.ts` grades accepted output. `src/storage/evals.ts` owns definition files
using the shared transaction queue. Evals execute through ordinary runs, including
model selection, finish validation, continuation and compaction. Never override
an agent's finish schema or expose grader expectations in model input. Eval tools
must not fall through to real execution; delivery hooks are suppressed. Graders
are trusted executables: snapshot identity, bound execution and retain uncertain outcomes
without replay. Schema grading precedes executable grading. Keep example fixtures and
TypeScript graders beside their agents, and generic engine/CLI tests under `test/`.
`src/engine/models/runtime.ts` coordinates model admission and residency.
`server.ts` owns llama.cpp process lifecycle; `client.ts` owns generation and
tokenization; `stream.ts` decodes streamed responses; `cache.ts` owns slot
identities, snapshot validation and pruning. Preserve exclusive provisioning,
active-slot ownership and process-group shutdown order.
Human presence or unhealthy presence sampling pauses background runs and requests
prompt model unloading after owned inference releases its slots. This path
bypasses idle retention and new optional cache saves; preserve existing disk
snapshots and transcripts. Explicit interactive work and model-test reservations
remain protected, including the admission gap before a run becomes live.

`src/engine/scheduling/timers.ts` owns recurring timer tracking; dispatch owns
live execution and policy admission. `src/storage/runIndex.ts` owns derived run
indexes. `src/storage/store.ts` owns the home lock and the single shared transaction
queue. `src/storage/config.ts` owns configuration persistence;
`src/storage/transcript.ts` owns run validation and persistence, committing derived
indexes only after durable writes. `src/storage/files.ts` owns atomic file writes,
permission checks and bounded reads. Configuration and transcript components do
not acquire separate queues; callers retain the shared `Storage.exclusive()` transaction.
`src/server/resources.ts` owns legacy HTTP resource adapters and `streams.ts`
owns event-stream state. HTTP hosting and authentication remain in http.ts.
`src/server/diagnostics.ts` owns capability and readiness reporting.
`src/storage/artifacts.ts` owns create-only run bundles, checksum manifests and
read-only run/bundle integrity verification.
`src/server/logging.ts` owns the operational event/field allowlist, severity filtering,
rate limiting and private bounded log rotation. Never log prompts, responses,
tool data, run lifecycle, configuration dumps, or facts reconstructible from
transcripts/state files. Log only additional daemon operational evidence.
`src/server/startup.ts` owns the per-user macOS LaunchAgent. Runtime files must remain
outside the source checkout. Default home is `~/.nightcrew`; this installation
may select another private runtime directory with `--home`.

Finite CLI commands emit one JSON envelope; diagnostics go to stderr. Reject
unknown options. Credentials never go in command flags, plists or logs. Keep
configuration writes atomic and serialized with daemon writes. Preserve run
snapshots, reject dangling references, and never delete run/model data when
uninstalling a service. External tools are trusted executables running with the local user’s permissions;
Nightcrew does not provide an OS sandbox or enforce read-only behavior.
`src/engine/capabilities/registry.ts` owns executable-only tool definitions, process execution
and the AgentRegistry that loads, validates and selects agent capabilities;
`src/engine/capabilities/commands.ts` owns bundled executable helpers.
`src/engine/capabilities/skills.ts` owns skill folder resources, canonical encoding, bounded on-demand
reads and skill catalog projection. Run resources must remain snapshotted; inject
only names/descriptions until requested. Auto-inject load_skills for agent loops
and instant chat; single-turn agents stay executable-tool-free. Opt-in `finishSchema` supplies a runtime-owned `finish` signal, never an executable registry entry. Validate its exclusive call before atomically committing completion; invalid results must fail immediately without another generation or dispatching sibling tools. Reject duplicate object keys before accepting structured results; retain the rejected response and validation evidence. There is no output repair loop or repairAttempts setting. Instant execution owns only
load_skills, never client-defined tools. Keep model arguments as typed
JSON on stdin. `argv` templates substitute validated parameters into individual
arguments without shell evaluation or recursive expansion; keep missing-value
checks and argument boundaries intact.

Use existing dependencies and Node APIs. Verify changes with package type checks
and focused integration tests; do not load production models merely to test the
CLI or service installation.

Keep command/schema snapshots aligned with runtime definitions. Intentional
contract changes require a SCHEMA_VERSION increment and a new immutable archive
via `npm run contracts:update`. Run `npm test` and `npm run test:package` for
CLI release milestones. Do not represent adapter support as verified model
behavior without an actual model-specific check.

Real-model tests live under `test/live/`, outside the default suite. Do not run
them without explicit authorization for inference.

The public contract is frozen at schema 53; follow
[the compatibility policy](https://oss.twocents.com/docs/nightcrew/compatibility/).
Do not remove or rename public commands, tighten accepted inputs, or change
execution semantics without explicitly reopening the freeze. Schema increments
alone do not authorize breaking changes. Keep
scheduler, cache and eval response schemas explicit. Eval submission and optional wait use ordinary run command deadlines.

Run-state reads are deadline-bounded; discard late read results without indexing
or mutating state. Never apply that timeout pattern to serialized writes, which
may still commit. Scheduler indexes for pending inputs and waiting compactions
are rebuilt from run files and updated only with committed state. Idle scheduling
must not reread every archived transcript. Record operational scheduler failures
separately from actual presence sampling failures.

Public CLI lifecycle lives under daemon, interactive calls under
instant, and fleet/presence/scheduling inspection under status. Evals expose shared management operations; there is no separate instant eval API.

Command names must use separate words, never hyphens. Flags may use hyphens.
HTTP listening is controlled by config.httpEnabled; never require an HTTP listener
for local CLI control. Cache inspection belongs in agents get, and root token
rotation belongs under config.

CLI wait/tail observers compose existing read contracts and never cancel accepted
work when a client disconnects, times out or receives a signal. Finite commands
emit one envelope; tails emit JSONL batches. Preserve accepted IDs on observation
errors. Transcript tails advance by committed event sequence; log tails follow
byte offsets and inodes without deduplicating identical lines by their text.

Repository-owned executable source, scripts, tests, and example helpers must use
TypeScript (`.ts`), never `.mjs`. Run standalone TypeScript with Node's
`--experimental-strip-types` flag on the minimum supported Node version.
Dependencies, generated `dist/`, and historical Git contents are outside this rule.
`test/contracts.test.ts` enforces the source-file ban and verifies immutable
contract snapshots; `test/contracts.ts --update` remains the explicit updater.
`test/package.test.ts` is opt-in through `npm run test:package`; ordinary tests
must not perform package installation. Keep strict type checks for tests and
scripts in `tsconfig.tests.json`, alongside the core source check.

Commander owns option parsing, cron-parser owns cron syntax and next-occurrence
semantics, and eventsource-parser owns SSE framing. Follow their native behavior
without compatibility exceptions. Nightcrew retains command contracts, scheduler
admission/no-catch-up policies, generation limits and completion validation.

`src/storage/runDocument.ts` owns the format-10 single-file run document and its derived engine projection. `src/storage/runEvents.ts` owns typed document event payloads and field mappings. Lifecycle events are flat; public transcript sequence is derived without changing event UUIDs. `validateTranscript` in `src/schemas/run.ts` owns integrity checks shared by persisted reads and artifact verification. Only state.json is written for run progress. Do not add a journal or multi-file transactions; unsaved progress can be lost on crashes. `src/storage/migrate.ts` is the explicit offline format migration with original-run backups.

`src/engine/models/operations.ts` owns temporary model smoke tests and explicit unloading. Both use Dispatch.withIdleRuntime to exclude scheduler work and competing model commands; shutdown aborts and settles that reservation. Model tests create no runs, hooks or durable contexts and never change instantModelID.

Models own contextTokens. Persist no slot array or scheduler contextTokens; derive
live slots in executionSlots. Agents use executionClass, not slotID. Only model
CRUD edits model definitions. Query runs with runs list --query and inspect policy
with status --scheduler; removed command names have no aliases. The latest
configurationChanged event selects a run snapshot; no top-level configurationID.

Instant requests never accept slotID. Runtime status owns the active-executions
array; do not reintroduce activeRunID or a duplicate scheduler.active. Run
execution state belongs in execution.state, never outcome.execution.

Executable handlers share executableSchema in schemas/tool.ts. Sampling settings share samplingSchema in schemas/common.ts; parallelToolCalls stays outside sampling. Agent structured output uses finishSchema only; Custom executable checks belong only in eval graders. Execution invalidOutput is terminal; delivery failures stay in hook events/receipts. Never reintroduce outcome.task, outputValidation configuration, or the recovery field (use toolLoop). Offline schema conversions live in storage/schemaMigration.ts; runtime readers reject retired fields. [The configuration guide](https://oss.twocents.com/docs/nightcrew/configuration/) explains authoring versus managed records.

Detailed reader documentation lives in `twocentinc/oss` under
`docs/content/docs/nightcrew/`. Update it there when public behavior or file
formats change. Keep `README.md` concise; retain runnable examples, runtime skill
assets, and immutable contract snapshots in this repository. Do not recreate a
second documentation tree here.
