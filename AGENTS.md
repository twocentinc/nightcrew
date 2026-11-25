# Nightcrew

Nightcrew is a standalone project. Use its spec and the owner's direct
instructions for planning and implementation. Keep application integrations and
their executable tools outside this repository.

`src/commands/` has one module per top-level CLI command. Each family owns its
request/result schemas, metadata and handlers; local-only families register their
commands there too. `definition.ts` builds shared authenticated oRPC procedures;
`operations.ts` aggregates them and `inputs.ts` aggregates their request schemas.
CLI, control socket and HTTP must invoke those same procedures. `registry.ts`
owns discovery, registration and offline dispatch. `resources.ts` owns shared
atomic resource transactions; resource-specific mutations stay in family modules.
`src/engine/protocol.ts` owns versioned envelopes, errors and request validation.
`src/cli.ts` owns parsing and finite command execution; `src/engine/execution.ts` owns
shared deadlines, diagnostics, and the owner-pipe process guard used for llama.cpp
tools and script hooks. Owner death must terminate their process groups, while
uncertain delivery receipts remain non-retryable without review. `src/server/daemon.ts` owns the private control socket. `src/server/http.ts` owns
HTTP/oRPC hosting and transport adapters; it must not own scheduling or agent
execution. `src/engine/` owns execution and domain behavior; `src/storage/` owns
durable state, transcripts and run artifacts.
`src/commands/management.ts` dispatches internal management calls to command families.
`src/engine/triggers.ts` owns schedule validation and next-occurrence calculation.
`src/engine/scheduler.ts` owns live-slot derivation, policy configuration, default planning
and bounded external policy hooks. `src/engine/service.ts` composes the engine and
keeps the shared service-facing API, initialization and shutdown order. Components
receive explicit, narrow dependencies, never the entire Service.
`src/engine/dispatch.ts` owns active executions, cancellation handles, timer
admission, plan revalidation, presence and interaction cooldown.
`src/engine/runs.ts` owns submissions, persistent conversation segments, pending
inputs and administrative run transitions. `src/engine/runner.ts` owns background
execution order and live runs. Its step modules receive explicit dependencies:
`src/engine/request.ts` builds model inputs, instructions and sampling settings;
`src/engine/inference.ts` records attempts and captures generation evidence, and
owns the streaming buffer shared with instant requests;
`src/engine/response.ts` assembles continuations and commits model responses;
`src/engine/tools.ts` recovers pending calls and commits paired tool results;
`src/engine/completion.ts` validates final output and settles interruption and
completion. Preserve the order of durable attempt, tool-result and message writes.
`src/engine/instant.ts` owns instant/eval request state, deadlines and generation.
`src/engine/context.ts` owns model-visible history projection, skill catalog
injection and transcript storage-limit checks. `src/engine/compaction.ts` owns
token budgets, linked compactor admission, checkpoint reconciliation and retries. `src/engine/hooks.ts` owns delivery tasks, durable
receipts, explicit retries and draining on shutdown.
`src/storage/records.ts` owns run projections, pagination snapshots, search,
event/save helpers and interrupted-run recovery inside the startup transaction.
`src/engine/configuration.ts` owns shared agent/configuration validation and
mutation; `src/engine/runtimeTypes.ts` owns the runtime adapter interfaces.
`src/engine/compactionFormat.ts` owns compaction handler/checkpoint schemas,
summary parsing, source evidence and bounded script execution. It generates domain-independent source
references for original records/text excerpts and restores selected evidence into
legacy resumed context; structured summaries retain source references only as checkpoint metadata and inject Markdown bullets. Summaries never own source identity or wording. The compaction component schedules linked compactor
runs; the runtime counts templated tokens and validates KV checkpoint generations.
Managed output-limit continuation is reconstructed from durable attempt records;
never validate/deliver partial answers or execute truncated tool calls.
Runs carry holds, pending inputs, compaction checkpoints, configuration and trigger
occurrence snapshots.
`src/engine/supervision.ts` owns output-validation configuration/execution, loop detection
and derived run outcomes, review fingerprints and effective hook retry chains. Keep validation evidence durable and never equate schema
validation or hook execution with factual correctness or confirmed external delivery.
`src/engine/evals.ts` owns versioned eval suites, exact argument mock dispatch and
create-only result bundles and optional executable end-of-case graders. Graders
are trusted local programs, separate from intercepted model tools. Snapshot their
identity, bound execution, and preserve failures and unreviewed criteria. Keep
agent-specific fixtures, tests, and TypeScript graders beside the example agent.
Keep tests of Nightcrew runtime, CLI contracts, and reusable infrastructure under
`test/`, even when their fixtures use named mock agents. Eval sampling in `src/engine/instant.ts` uses the instant
scheduler but never executes tools, skills, hooks or compaction. Keep evaluation
expectations out of model inputs and unreviewed criteria distinct from passes.
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
`src/engine/registry.ts` owns executable-only tool definitions, process execution
and the AgentRegistry that loads, validates and selects agent capabilities;
`src/engine/toolCommands.ts` owns bundled executable helpers.
`src/engine/skills.ts` owns skill folder resources, canonical encoding, bounded on-demand
reads and skill catalog projection. Run resources must remain snapshotted; inject
only names/descriptions until requested. Auto-inject load_skills for agent loops
and instant chat; single-turn agents stay executable-tool-free. Opt-in `finishSchema` supplies a runtime-owned `finish` signal, never an executable registry entry. Validate its exclusive call before atomically committing completion; invalid results must not complete or dispatch sibling tools. Reject duplicate object keys before accepting structured results; repair feedback must explain the lost-item risk. Instant execution owns only
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

The public contract is frozen at schema 34; follow `docs/compatibility.md`.
Do not remove or rename public commands, tighten accepted inputs, or change
execution semantics without explicitly reopening the freeze. Schema increments
alone do not authorize breaking changes. Keep
scheduler, cache and eval response schemas explicit. Eval suite CLI deadlines
are separate from individual case limits and ordinary management deadlines.

Run-state reads are deadline-bounded; discard late read results without indexing
or mutating state. Never apply that timeout pattern to serialized writes, which
may still commit. Scheduler indexes for pending inputs and waiting compactions
are rebuilt from run files and updated only with committed state. Idle scheduling
must not reread every archived transcript. Record operational scheduler failures
separately from actual presence sampling failures.

Schema 31 consolidates public CLI lifecycle under daemon, interactive calls under
instant, and fleet/presence/scheduling inspection under status. Internal eval
sample/release procedures must not be exposed in CLI or HTTP discovery.

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
contract snapshots; `scripts/contracts.ts --update` remains the explicit updater.
`test/package.test.ts` is opt-in through `npm run test:package`; ordinary tests
must not perform package installation. Keep strict type checks for tests and
scripts in `tsconfig.tests.json`, alongside the core source check.
