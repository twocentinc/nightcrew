# Nightcrew

Nightcrew is a standalone project. Use its spec and the owner's direct
instructions for planning and implementation; do not use an application-specific planning system.
Keep it independent of the client application and Guildscribe runtime imports.

`src/commands.ts` owns command definitions, help, schemas and dispatch.
`src/protocol.ts` owns versioned envelopes, errors and request validation.
`src/cli.ts` owns parsing and finite command execution; `src/execution.ts` owns
shared deadlines and diagnostics. `src/daemon.ts` owns the private control socket.
`src/management.ts` implements configuration and run management operations.
`src/diagnostics.ts` owns capability and readiness reporting.
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
uninstalling a service. External tools must explicitly declare read-only intent;
this is a trusted administrator contract, not an OS sandbox guarantee.

Use existing dependencies and Node APIs. Verify changes with package type checks
and focused integration tests; do not load production models merely to test the
CLI or service installation.

Keep command/schema snapshots aligned with runtime definitions. Intentional
contract changes require a SCHEMA_VERSION increment and a new immutable archive
via `npm run contracts:update`. Run `npm test` and `npm run test:package` for
CLI release milestones. Do not represent adapter support as verified model
behavior without an actual model-specific check.
