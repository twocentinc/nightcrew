# Public contract and compatibility

The public contract is frozen as of 0.31.4, protocol 1, schema 34 (November 22,
2026). This is the compatibility baseline for the upcoming 1.0 release, not a
claim that 1.0 acceptance work is complete. It supersedes the earlier policy
allowing arbitrary breaking changes before v1.

## Stable surfaces

- CLI command paths, documented flags and operands, request/result schemas,
  JSON envelopes, exit codes, wait/tail behavior, and acceptance semantics.
  `help --advanced` commands are public too.
- Public oRPC management procedures and their generated HTTP operations and
  TypeScript router contract. Existing HTTP resource and streaming routes remain
  supported as implemented; new clients should prefer shared management operations.
- Configuration and agent/model/trigger/tool/skill definitions accepted at this
  baseline, including defaults that affect execution or side effects.
- Documented executable tool, skill resource, lifecycle hook, scheduler hook,
  compaction hook, eval suite, and exported run-bundle formats.
- Readability and safe continuation of durable run/configuration data created by
  supported releases. Transcripts, IDs, tool outcomes, and uncertain delivery
  records must survive upgrades.

The runtime sources named in AGENTS.md own exact definitions. The immutable
`test/snapshots/versions/v34.json` archive records the CLI and shared schema
baseline. It does not cover every HTTP route, behavioral guarantee, or hook:
those also require source review and behavioral tests. Do not maintain a second
handwritten endpoint inventory.

## Change policy

Compatible additions may introduce optional inputs or new commands without
changing existing behavior. Clients should tolerate additional output fields.
Changing the meaning/type of a field, removing a command, tightening previously
valid inputs, adding a required input, or changing execution-affecting defaults
is breaking. New enum variants also require compatibility review; callers may
handle them exhaustively.

Patch releases fix behavior to match the contract. Minor releases add compatible
capabilities. The eventual 1.0 release preserves this baseline. Breaking changes
require explicit owner approval, a documented migration/deprecation plan, and a
new major release after 1.0; before 1.0 they require explicitly reopening this
freeze. A schema-number increment alone does not authorize a breaking change.
Every schema change still gets a new immutable archive; never edit old archives.

Persisted-format changes must retain supported readers or provide an explicit,
validated migration. Preserve unknown external-side-effect outcomes; migration
must never replay work or send messages. Do not silently discard data. Downgrades
and arbitrary cross-version mixing of daemon and CLI are not guaranteed: use the
same installed package, stop the daemon before upgrading, retain a backup of the
runtime home, then verify with doctor and read-only run inspection. There is no
general automatic migration or downgrade command promised by this policy.

## Outside the freeze

Private implementation modules, control-socket internals, process/PID files,
operational log wording, disposable KV caches, model-generated prose and example
agent prompts are not stable integration APIs. Use management commands rather
than editing run files. Examples and optional the client application workflows may improve;
they must still respect documented executable interfaces and delivery safety.
Model quality, throughput and external service availability are not guarantees.

macOS is the validated unattended host (LaunchAgent and desktop presence).
Other platforms do not have equivalent validated presence/service support.
No UI, distributed scheduling, automatic transcript pruning, instant-request
compaction, or workspace pipelines are required for this baseline.

## Release checks

Run type checks, the full mocked suite, contract checks and package installation
smoke tests. Review changes against this policy, including behavior not captured
by snapshots. Real inference remains opt-in. See acceptance.md for completed
controlled live checks and the outstanding overnight/abrupt-crash validation;
passing mocked tests must not be described as those checks passing.
