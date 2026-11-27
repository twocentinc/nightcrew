# Public contract and compatibility

The current frozen public contract is protocol 1, schema 53, introduced in
0.53.0 through owner-approved request and response simplification. The freeze began at schema 34;
owner-approved changes since then are recorded below. This is the baseline for
the upcoming 1.0 release, not a claim that acceptance work is complete.

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
  compaction hook, eval definition/grader, and exported run-bundle formats.
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
runtime home, then verify with `status --doctor` and read-only run inspection. There is no
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

## Approved simplification (0.41.0 / schema 42)

The owner explicitly reopened the contract for these changes. There are no aliases.

- Diagnostics are `status --doctor` (oRPC `status` request `{ "doctor": true }`); plain status remains fast. Diagnostics also work locally with the daemon stopped.
- Instant requests use `instant create/get/delete`; delete cancels active execution and discards the transient result.
- `models unload` unloads the configured instant model, refusing unrelated active background work. It takes no model ID.
- Agent KV removal is `agents cache delete`; run capability adoption is `runs refresh`.
- Manual run annotations, review decisions and public hook retries are removed.
- Outcome attention is derived from execution, validation, recovery and delivery evidence (`needsAttention`); status exposes `issues` and `issuesTruncated`. No manual resolution can hide failures.
- Stored review records and annotation/review events are removed in the installation migration. Renumber retained events and remap hook receipt eventSequence references together; never change message or attempt evidence. Stop the daemon during migration and validate all runs before restarting.
- Previous contract archives remain immutable historical release evidence.

## Consistency audit (0.41.1, schema 42)

Online `status --doctor` invokes the same authenticated status operation as HTTP and TypeScript. When the control socket is unavailable, the CLI runs read-only local diagnostics, reports the daemon as unavailable, and does not create a runtime home. Other daemon errors are preserved rather than replaced with local results.

Generated `/v1/operations/...` routes are the complete remote management surface, except local-only filesystem operations. Older resource routes are explicitly shaped adapters (for example, `/v1/status` returns runtime status only); they are not a second management inventory. Clients needing the CLI-shaped result use the operation routes.

## Approved run schema redesign (0.42.0 / schema 43)

- Stored run version 3 replaces top-level state/held/pauseReason/error with one
  `execution` object. Run detail, lists, status and exports use that same shape.
  This does not change the transient instant-request state contract.
- Events carry UUIDs and validated type-specific payloads. Tool snapshots use
  the executable tool schema, including pending inputs and refresh evidence.
- Configured hooks require `hookID`. Receipts carry `receiptID`, `eventID`,
  `retryOfReceiptID`, nullable `startedAt` and `finishedAt`; executablePath is
  execution evidence, not identity. Automatic delivery deduplicates by eventID
  and hookID, regardless of executable relocation.
- Hook results carry sourceEventID and receiptID. Historical events without an
  unambiguous receipt association retain null receiptID. Unrecorded historical
  timing remains null; migration must not invent timing or delivery outcomes.
- Pauses declare manual or automatic resumption. Storage pauses include the
  exhausted resource, used count/bytes and maximum. Increasing MB only resolves
  byte limits; count limits require a new run or an explicit future retention policy.
- Upgrade offline: back up config.json and every state.json, assign hook/event/
  receipt IDs, replace positional references, convert execution and validate all
  records before atomic replacement. Preserve message IDs, content, attempt
  evidence, receipt outcomes, compaction links and run IDs. Migration never
  dispatches hooks. Update external consumers to read execution.state before
  restarting. There is no old-format reader or compatibility alias.

## Approved eval redesign (0.43.0 / schema 44)

- Replaces suites/cases, assertion lists, semantic criterion statuses, result destinations, and instant sample/release with saved eval definitions and ordinary runs. No compatibility aliases or old-suite importer.
- Adds shared eval CRUD/run, tool-response editing, and starting-transcript editing commands.
- Grading uses optional expected JSON Schema followed by optional executable `{passed, reason}` grading; expected schemas never override the agent finish schema.
- Run records gain optional `evaluation` snapshots/grade and `evalGraded` events. Existing ordinary run/config files remain readable; no migration is required for them. Prior standalone eval artifacts remain files and are not new saved definitions.
- The complete current protocol is documented in [eval-format.md](eval-format.md). Earlier immutable command archives remain historical evidence only.

## Single-attempt final output (0.44.0 / schema 45)

- Invalid `finish` arguments, mixed finish/tool batches, text in place of a required finish call, and rejected/errored final-output validation fail execution immediately. No model correction request is made.
- Removes `outputValidation.repairAttempts` from agent configuration and snapshots. Before upgrading an existing home, back up its configuration and run files, then remove this property from configured agents, each run's agent snapshot, and pending-input agent snapshots. Preserve all transcripts, validation records, and historical outcomes. New requests containing the retired field are rejected; there is no compatibility alias.
- Eval grading remains a hidden post-run check and cannot repair output. Explicit manual retry/reply remains available. Ordinary tool-error handling and incomplete-generation continuation are unchanged.

## Single-file run documents (0.45.0 / schema 46)

- Stored format 4 keeps metadata, messages and events together in state.json.
  No multi-file journal or transactional replay is required; latest unsaved
  progress may be lost on a crash.
- Numeric segment is removed from run, event, attempt and hook contracts.
  `turnID` is the originating user message UUID. Update hook consumers accordingly.
- CLI projections retain derived result and inspection fields. State files no
  longer duplicate those fields; direct file readers must use the document
  projection rather than assume the previous top-level arrays.
- Migrate offline using `dist/storage/migrate.js`; original directories are
  backed up before replacement. No compatibility reader or old field aliases.
- Unresolved started tool calls pause rather than replay. This is conservative
  recovery for external side effects, not a promise to recover unsaved output.

## Model testing and unloading (0.46.0 / schema 47)

- `models test MODEL_ID --prompt TEXT` performs temporary chat inference without a run or agent. It returns `{modelID, changed, elapsedMs, result}`; dry runs return null result and do not load weights.
- `models unload MODEL_ID` or `models unload --all` replaces the implicit instant-model target. No selector, or both selectors, is invalid. It returns `{modelIDs, unloadedModelIDs, changed}`.
- Unloading now refuses active work rather than cancelling instant work. There is no compatibility alias for the old destructive behavior.
- Both commands use the shared authenticated oRPC contracts and require the daemon. CLI operands now support the declared optional-ID contract used by `models unload`; JSON flags reject duplicate fields.

## 0.47.0 storage simplification

- The CLI/oRPC contract remains at schema 47. Flag mappings now live beside each
  command definition; flags, duplicate-input handling and requests are unchanged.
- Run documents use format 5: typed event payloads, flat lifecycle events and no
  redundant `inFlight` pointers. Public run projections and exported bundles
  retain their version-4 shape, event UUIDs and transcript sequence cursors.
- Stop the daemon and run `node dist/storage/migrate.js --home ABSOLUTE_HOME`
  to preview the offline upgrade, then add `--apply`. Formats 3 and 4 are
  supported migration inputs; original run directories are backed up. The normal
  reader accepts only format 5. Migration never executes tools or delivery hooks.

## 0.48.0 / schema 48 consolidation

- Models own `contextTokens`; remove configuration `slots`, scheduler
  `contextTokens`, model-create `slots`, and agent `slotID`. Agents use
  `executionClass: background|instant`. Slot allocation is derived from models,
  `maxConcurrent` and the selected instant model.
- `config update` and its HTTP adapter no longer accept models, slots or
  `modelIdlePolicies`. Model CRUD is the sole public model-editing surface.
- Replace `runs search TEXT` with `runs list --query TEXT`, preserving search
  evidence. HTTP uses `/v1/runs?query=TEXT`; the old search route is removed.
- Replace `scheduler explain` with `status --scheduler`. Policy hooks execute only
  on explicit scheduler inspection or ordinary scheduling, never plain status.
- Configuration format 3 and run document format 6 require the offline migration
  described above. The latest configuration event replaces the document's
  top-level `configurationID`. Original files are backed up. Retain transcripts;
  stale slot caches are disposable and may rebuild after this upgrade.
- This is an owner-approved breaking pre-1.0 change; removed inputs and commands
  are rejected rather than retained as compatibility aliases.

## 0.49.0 / schema 49 field cleanup

- Instant requests no longer accept `slotID`; the daemon selects its designated
  instant slot. The optional `modelID` remains an expected-model check.
- Run outcomes no longer repeat execution state. Read `run.execution.state`.
- Runtime status replaces `activeRunID` with `active`, an array of
  `{ id, kind, modelID, slotID }` for all current run/chat executions. Detailed
  scheduler status no longer repeats that array. Each slot's conversationID
  describes only the chat actually using that slot.
- These approved removals have no aliases. Run document format 6 and configuration
  format 3 are unchanged; no durable-data migration is required.

### Run document format 7

- Collection events derive identity from their value instead of duplicating it in `data.key`.
- Normal reads accept only format 7. The offline migration upgrades existing runs with backups; public schema 49 is unchanged.

## 0.50.0 / schema 50

- All executable handlers use executablePath, argv, timeoutMs.
- Agent output uses finishSchema plus optional executable finishValidator; outputValidation is removed. Eval grading remains independent.
- Execution adds invalidOutput. outcome.task is removed; delivery stays in events and receipts.
- Temperature moves into sampling; parallelToolCalls moves out. Eval tool references use toolID.
- Modes are singleTurn/agentLoop; pause reasons use contextFull/runtimeError/storageLimit. Tool-loop bookkeeping is toolLoop.
- Configuration format 4 and run format 8 migrate offline with backups. Installed eval definitions are upgraded too. No runtime aliases accept retired fields.
- See [authoring and runtime files](configuration.md) for minimal examples and version domains.

## 0.51.0 / schema 51

- finishValidator is removed and rejected on create/update. Regular structured completion uses finishSchema only; custom executable checks belong in eval graders.
- Configuration format 5 and run format 9 remove old validators offline, with backups. Historical validation evidence is preserved without rerunning checks.
- The supervisor example grades report coverage in evals; its production report writer only renders and saves output.

## 0.52.0 / schema 52

- Removed internal hook retries and receipt retry/request/note fields. Hook/event identities still prevent duplicate dispatch. Historical originals remain in migration backups.
- Capability refresh events retain time, turn and source revision; configuration events own tool and skill snapshots. Older migrations may have flattened configuration history; any snapshots found only in retired refresh fields remain available in the original-run backup.
- Removed the repetitive outcome.nextAction field.
- Removed evals transcript clear; use transcript set with messages: [] instead.
- skills list returns only skillID, name, description and hash, including HTTP listings. Use get/read for content.
- Run format 10 requires offline migration from formats 3–9; configuration stays at format 5. Migration retains existing configuration events instead of reconstructing only the latest snapshot.

## 0.53.0 / schema 53

- Message inputs may omit attachments, toolCalls and toolCallID. Normalized engine/output records keep empty arrays/nulls. Role validation permits attachments only on users, calls only on assistants, and requires toolCallID only on tool results.
- Tools and skills update through expectedHash + changes. Omitted fields are preserved; arrays and nested schemas are replaced when supplied. Identities cannot change. Full merged definitions are validated before writes.
- Agents and tools list metadata; get returns full definitions. HTTP resource listings follow the same projections.
- Model mutations return item (null after deletion), revision, changed and restartRequired instead of all configuration. Dry-run revision describes the proposed configuration without writing it.
- models test no longer accepts parallelToolCalls; model tests have no tools.
- Configuration format 5, run format 10 and protocol 1 are unchanged. No migration is required.
