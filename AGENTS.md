# Nightcrew

Nightcrew is a standalone project. Use its spec and the owner's direct
instructions for planning and implementation; do not use an application-specific planning system.
Keep it independent of the client application and Guildscribe runtime imports.

`src/operations.ts` owns shared oRPC procedures, results and management command
metadata; `src/operationInputs.ts` owns their request schemas. CLI, control socket
and HTTP must invoke those procedures. `src/commands.ts` derives management
commands from them and owns local command definitions and discovery.
`src/protocol.ts` owns versioned envelopes, errors and request validation.
`src/cli.ts` owns parsing and finite command execution; `src/execution.ts` owns
shared deadlines and diagnostics. `src/daemon.ts` owns the private control socket.
`src/management.ts` implements configuration, trigger and queue management.
`src/triggers.ts` owns schedule validation and next-occurrence calculation.
`src/scheduler.ts` owns live-slot derivation, policy configuration, default planning
and bounded external policy hooks. `src/service.ts` owns timer admission, plan
revalidation, per-slot execution and persistent single-run conversation segments.
`src/compaction.ts` owns compaction handler/checkpoint schemas, safe history
projection and bounded script execution. The service schedules linked compactor
runs; the runtime counts templated tokens and validates KV checkpoint generations.
Runs carry holds, pending inputs, compaction checkpoints, configuration and trigger
occurrence snapshots.
`src/supervision.ts` owns output-validation configuration/execution, loop detection
and derived run outcomes, review fingerprints and effective hook retry chains. Keep validation evidence durable and never equate schema
validation or hook execution with factual correctness or confirmed external delivery.
`src/diagnostics.ts` owns capability and readiness reporting.
`src/runArtifacts.ts` owns create-only run bundles, checksum manifests and
read-only run/bundle integrity verification.
`src/logging.ts` owns the operational event/field allowlist, severity filtering,
rate limiting and private bounded log rotation. Never log prompts, responses,
tool data, run lifecycle, configuration dumps, or facts reconstructible from
transcripts/state files. Log only additional daemon operational evidence.
`src/startup.ts` owns the per-user macOS LaunchAgent. Runtime files must remain
outside the source checkout. Default home is `~/.nightcrew`; this installation
may select a home below a private runtime directory with `--home`.

Finite CLI commands emit one JSON envelope; diagnostics go to stderr. Reject
unknown options. Credentials never go in command flags, plists or logs. Keep
configuration writes atomic and serialized with daemon writes. Preserve run
snapshots, reject dangling references, and never delete run/model data when
uninstalling a service. External tools are trusted executables running with the local user’s permissions;
Nightcrew does not provide an OS sandbox or enforce read-only behavior.
`src/registry.ts` owns executable-only tool definitions and process execution;
`src/toolCommands.ts` owns bundled executable helpers.
`src/skills.ts` owns skill folder resources, canonical encoding, bounded on-demand
reads and skill catalog projection. Run resources must remain snapshotted; inject
only names/descriptions until requested. Auto-inject load_skills for agent loops
and instant chat; single-turn agents stay tool-free. Instant execution owns only
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

