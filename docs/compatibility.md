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
than editing run files. Examples and external integration workflows may improve;
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

## Owner-approved compaction policy revision (November 23, 2026)

The owner explicitly approved increasing the shared summary target ceiling from
1024 to 4096 tokens, removing the 180-word prompt cap, and preserving the target
on automatic retries. This narrowly reopens the execution-policy freeze for
those changes. Request/result schemas and durable formats are unchanged. Existing
pending compactions retain their saved target; newly prepared compactions use
the larger ceiling subject to available context. No transcript migration or
external action replay is required.

Schema 39 adds opt-in nullable `finishSchema` and optional structured compaction
checkpoint metadata. Existing agents default to ordinary text completion and old
checkpoints retain their rendering. New finish behavior applies only to agents
that explicitly opt in; existing run snapshots are not silently refreshed.

## Application boundary cleanup

The owner explicitly approved removing bundled application integrations and their
executable from the package. Nightcrew commands and schemas are unchanged; external
integrations consume the public CLI and own their credentials and delivery logic.

## Structured result validation refinement

Owner-approved validation now rejects duplicate object keys in generated structured
results and finish arguments, with repair guidance. This prevents silent data loss
from JSON parsing. CLI request schemas and other tool arguments are unchanged.

## Executable eval graders (0.39.0, schema 40)

Optional suite graders execute after each case through the bounded executable
runner. They receive hidden expectations, the complete trace and execution outcome,
then return named pass/fail/review checks. Execution errors and deterministic
failures cannot become passes through grading. Grader failures are recorded as eval
errors; unaddressed semantic criteria remain unreviewed. Existing suites without
graders retain their behavior.

This is an approved additive contract change. Agent-specific fixtures, TypeScript
graders and checks are colocated under their example directories. See
[the eval format](eval-format.md) for the canonical executable protocol.

## Owner-approved parser adoption (November 24, 2026)

Version 0.40.0 / schema 41 adopts Commander, cron-parser and eventsource-parser
with their native behavior, as explicitly requested by the owner. This reopens
only parser semantics; command paths, JSON envelopes and run/delivery policies
remain unchanged. Older version archives remain immutable.

Commander accepts grouped short aliases and repeated options (last value wins).
Cron expressions use the library's syntax and calendar validation, including
optional seconds, names and macros. Invalid calendar expressions previously
accepted by the numeric parser must be corrected before loading configuration.
Review saved schedules: nonexistent DST hours can move to the landing hour, and
forward iteration suppresses repeated hours. There is no catch-up scheduling.
SSE responses must use complete event framing; a trailing unterminated data line
is no longer treated as a complete event. Model completion and output limits
remain enforced independently of framing.
