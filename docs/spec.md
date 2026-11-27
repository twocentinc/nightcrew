# Nightcrew specification

- Current release: **0.53.1**. Frozen public contract: **protocol 1, schema 53**.
- Configuration disk format: **5**. Run disk format: **10**. Expanded run views and export bundles use version **4**.
- Runtime schemas and registered procedures are authoritative. Use `nightcrew help` and `nightcrew schema get RESOURCE.ACTION` for exact commands and request/result shapes.
- [Compatibility policy](compatibility.md) records the freeze and historical changes. This document describes current behavior.
- [Configuration guide](configuration.md) explains authoring files; [eval format](eval-format.md) defines eval authoring; [validation guide](acceptance.md) explains testing and evidence.

## Purpose and boundaries

- Nightcrew is a standalone CLI and daemon for local llama.cpp serving, instant requests, and background agents. Application integrations live outside the repository.
- The daemon resolves `llama-server` from `PATH` and provisions it on demand. Models reference existing weights and optional projectors; Nightcrew does not download weights.
- One model is resident at a time. Compatible work can share that model through separate slots; scheduling controls residency and switching.
- macOS provides the supported LaunchAgent and desktop-presence integration. Other platforms do not have equivalent validated unattended support.
- Deferred [workspace pipelines](pipelines.md) are a future design, not implemented behavior or approved implementation scope.

## Source organization

- `src/cli.ts` owns parsing and finite command execution.
- `src/commands/` contains one module per top-level command family, owning its schemas, metadata, and handlers.
- `src/utils/commands/` owns shared oRPC definitions, typed request parsing, discovery, dispatch, and resource transactions.
- `src/schemas/` owns shared validators. Import from the owning module; do not add competing inventories.
- `src/engine/service.ts` composes narrowly scoped components:
  - `runs/`: submissions, replies, controls, persistent turns, and trigger admission.
  - `execution/`: context, requests, inference, responses, tools, completion, and bounded processes.
  - `instant/`: transient interactive requests and their skill loop.
  - `scheduling/`: admission, timers, priorities, and scheduler policy.
  - `models/`: runtime admission, llama.cpp lifecycle, generation/tokenization, streaming, and KV caches.
  - `compaction/`: summary coordination, evidence, validation, and recovery.
  - `capabilities/`: tools, skills, snapshots, and bundled helpers.
  - `evals/`: definitions, substituted tool results, and grading.
- `src/storage/` owns the shared transaction queue, configuration, atomic run documents, derived indexes, migrations, and export verification.
- `src/server/` owns HTTP, the private control socket, LaunchAgent management, logging, and diagnostics.
- `src/utils/json.ts` owns canonical JSON serialization and fingerprints.
- Public npm exports are `nightcrew` and `nightcrew/operations`. Internal file paths are not compatibility entry points.

## Canonical contracts and transport

- CLI, HTTP management, offline management, and the private control socket invoke the same oRPC procedures. Their schemas come from command-family definitions.
- Remote operations mount as `POST /v1/operations/<resource>/<action>`. The envelope contains `request`, a `resourceID` when appropriate, and optional `dryRun`/`yes` flags.
- Eligible existing HTTP resource routes and event streams remain supported. Resource adapters delegate management to the shared procedures; they retain their documented envelopes and pagination.
- TypeScript clients import `ManagementRouter` from `nightcrew/operations`. `/openapi.json` is generated from the router.
- HTTP uses one global root bearer token, hashed at rest. Health and OpenAPI are public. The listener binds loopback; remote exposure requires an external transport. There are no per-client grants.
- `httpEnabled: false` plus a restart disables HTTP, while the private local CLI socket continues working. `config token rotate` replaces the root token.
- Bootstrap, service installation, local logs, and discovery are CLI concerns. Run export and bundle verification require local filesystem access.
- Finite CLI commands emit one JSON envelope; diagnostics go to stderr. Tails emit JSONL envelopes. Unknown inputs are rejected, and mutations expose dry runs and confirmation where specified by help.

## Configuration and resources

- The default runtime home is `~/.nightcrew`, selected through `--home` or `NIGHTCREW_HOME`. Configuration stores models, agents, scheduler settings, lifecycle hooks, and triggers; it does not embed run history.
- Models own `contextTokens`, weight/projector paths, kind, priority, idle unloading, optional slot snapshots, and an optional compaction threshold.
- Agents select their model, prompt, `singleTurn` or `agentLoop` mode, `fresh` or `persistent` context, `background` or `instant` execution class, capabilities, and limits.
- Generation settings use `sampling.temperature`, `topP`, `topK`, `minP`, `presencePenalty`, and `repeatPenalty`. `thinking`, `parallelToolCalls`, and `maxOutputTokens` are separate fields.
- Agents and triggers use their own revision checks; model/configuration changes use the configuration revision; tool/skill changes use content hashes.
- Updates use `changes`. Omitted fields remain unchanged; supplied arrays and nested objects replace their prior values. Full merged definitions are validated before writes.
- Agent, tool, and skill listings return metadata. `get` retrieves full definitions. Model mutations return `item`, `revision`, `changed`, and `restartRequired`; deletion returns a null item.
- Model CRUD owns model definitions; `config update` does not replace the model collection. Definitions cannot be deleted while referenced.
- CLI tool/skill mutations reload registrations. `config reload` adopts direct filesystem edits. Existing runs keep their admitted snapshots unless explicitly refreshed.
- Examples are opt-in. `init` creates an empty installation rather than installing bespoke agents.

## Tools and on-demand skills

- Tools are trusted executables configured with `executablePath`, `argv`, `timeoutMs`, `toolID`, `description`, and an object JSON Schema in `parameters`.
- Validated parameters arrive as JSON on stdin; stdout must be JSON. Tools default to 10000 ms, accept 100–600000 ms, and have a 1 MB output limit.
- `argv` supports `%parameter%`, dotted paths, and `%%` for a literal percent. Each substitution stays inside one argument. There is no shell expansion, recursive substitution, array spreading, or automatic omission of flags. Missing values fail before launch; expanded arguments reject NUL and exceed neither the configured nor runtime size limits.
- Tools run with the local user's permissions. Minimal environment and bounded process execution are not an OS sandbox or a read-only guarantee. Legacy adapter definitions are not accepted by normal readers.
- Skills are folders containing `SKILL.md`, with optional `references/` and `assets/`. Resources are bounded to 128 KB per file, 64 files, and 512 KB serialized resource data per skill. Traversal and symlink escapes are rejected.
- Skills provide guidance, not extra tool permissions. Only configured `skillIDs` appear in the model's catalog. Instructions and files are read on demand through the automatic `load_skills` tool.
- `skills read` reads selected instructions/resources without changing state. Run snapshots preserve admitted content across edits, interruptions, and exports.
- The bundled `runs_list` and `runs_transcript` helpers provide bounded historical evidence. They exclude the current nonterminal run; worker history is bounded and marks truncation. Administrator transcript reads retain full evidence.
- Ordinary malformed calls, unavailable tools, schema/argv errors, executable failures, and invalid output become paired tool error messages. Errors before execution report `not_started`; errors after possible execution report `unknown`. Nightcrew does not automatically replay side effects.
- Cancellation, preemption, active-time deadlines, storage failures, and context limits remain execution controls, not recoverable tool responses.

## Runs and messages

- Fresh agents create independent runs. Persistent agents retain one run ID and transcript across invocations; each turn has its own active-time budget.
- Clients generate message UUIDs. Identical resubmission of an accepted UUID deduplicates; conflicting reuse is rejected. Attachments and optional thinking overrides belong to each user message.
- Input messages may omit empty `attachments`/`toolCalls` and null `toolCallID`. Normalized records retain those defaults. Only users attach files, only assistants call tools, and tool results must reference their call ID.
- `singleTurn` produces a final response without executable tools; `agentLoop` can continue through tool calls. Output-limit continuation can require more than one generation in either mode.
- Active time counts toward `timeoutMs`; paused time does not. Thinking traces and partial attempt evidence are retained separately from completed answers. A crash can lose deltas after the latest saved checkpoint.
- Completed and cancelled runs can receive replies. A reply to a cancelled run starts a new turn without reviving cancelled pending inputs. Failed/timed-out fresh runs use explicit retry controls.
- `execution.state` describes execution. `outcome` separately reports output validation, delivery, hooks, `needsAttention`, and `reasons`. Delivery failure does not rewrite successful inference as failed; validation does not establish factual correctness.

### Schema-validated completion

- `finishSchema` is optional and describes an object. It enables the runtime-owned `finish` tool for chat agents, including `singleTurn` agents. It is never an executable tool registration.
- The agent must call `finish` alone with valid arguments. Ordinary text, mixed batches, malformed arguments, duplicate JSON keys, or schema mismatch fail immediately as `invalidOutput`. There is no finish repair loop or production executable validator.
- Accepted output is recorded with completion evidence; lifecycle delivery remains separate. Without `finishSchema`, an ordinary final answer completes the turn.
- `maxToolCalls` counts attempted executable/builtin calls per user turn. Excess calls receive errors without executing; finalization disables ordinary tools and thinking. `finish` remains available when configured.
- A tool-free empty visible response in an `agentLoop` gets one finalization attempt before failing. This is not a retry of rejected `finish` output.

### Managed response continuation

- `maxOutputTokens` limits each generation. A complete stream ending at the output limit records partial text, reasoning, and tool fragments and requests continuation.
- Text continuation uses exact assistant prefill. Incomplete tool calls never execute; complete calls must be regenerated. Thinking-only limits retain the draft and request a visible answer with thinking disabled.
- Completion validation and delivery use the assembled answer, never a partial chunk. Active-time, context, storage, and assembled-response limits still apply.
- Continuation is reconstructed from saved attempts across interruption, restart, and compaction. Instant requests do not use this managed-run continuation mechanism.

## Scheduling, triggers and interactive work

- Pending work lives in run state and queued message events. There is no separate queue database or queue command family: use run controls and `status`.
- Triggers support manual firing, fixed intervals, and cron with explicit timezone. Cron syntax and DST behavior follow `cron-parser`. Missed occurrences are skipped rather than caught up; ordinary dispatch has a small lateness allowance.
- `skip`, `enqueue`, and `coalesce` govern overlapping trigger work. `triggers fire` submits a saved trigger without shifting its schedule. A stable `occurrenceID` deduplicates retries.
- Disabling an agent/trigger or timers changes future admission, not accepted history. Scripts and HTTP clients can also submit ordinary turns; polling can be implemented by an agent's first tool call.
- Background admission requires healthy desktop-away detection and an expired interaction cooldown. Instant work preempts background computation and renews `interactionCooldownMs`, default five minutes.
- `scheduler.instantModelID` selects the interactive model. Manual instant-agent turns use that model's interactive admission; timer and eval work remain background.
- The scheduler derives physical slots from model configuration and `maxConcurrent`. Agents do not own permanent physical slots or configure `slotID`.
- The built-in policy combines agent/model priority, resident-model preference, minimum residency, and wait aging. An optional scheduler executable proposes starts/pauses; Nightcrew validates eligibility, dependencies, ownership, and capacity. Hook failure policy selects built-in fallback or hold.
- `status --scheduler` evaluates policy, including its hook, without dispatching work. Plain status does not invoke the scheduler hook.
- Instant requests select their own skills and client tool definitions. Nightcrew executes only its skill reads; client tool calls return to the client. Skill execution is bounded by the request deadline, round count, and memory limits.
- Instant request state is transient, expires after termination, and is not saved as a run. Clients supply their conversation history on subsequent requests.

### Models and caches

- `models test MODEL_ID --prompt TEXT` sends a tool-free prompt to configured chat weights without creating a run or changing the instant model. Defaults: thinking off, 64 output tokens, `sampling.temperature: 0`, and a 60000 ms request timeout. It does not accept `parallelToolCalls`.
- Model testing and `models unload MODEL_ID` / `models unload --all` require an idle runtime. They do not cancel busy work. Unloading releases the owned server, not weights, disk caches, or the OS filesystem cache.
- Model `slotSnapshots` controls disk KV snapshots. The default location is `<home>/slots/<modelID>`; an absolute base directory can be configured. The scheduler enforces the snapshot budget.
- Persistent contexts can restore an agent-owned snapshot into a borrowed slot. Missing/incompatible snapshots rebuild from the authoritative transcript. Fresh contexts clear on takeover.
- `agents get` inspects caches; `agents cache delete` removes saved KV without deleting transcripts. Caches are disposable acceleration, not durable conversation history.

## Context compaction

- Context capacity and transcript storage are separate. Nightcrew counts templated input, including tools and instructions, reserves output space, and disables context shifting. A model's `compactionThresholdTokens` can trigger compaction earlier.
- An agent chooses an executable summary handler or a separate `singleTurn` summarizer agent. The parent retains its run ID and original messages; a checkpoint records coverage, summary, token counts, and optional child identity.
- Coverage ends at a complete message/tool-exchange boundary. Requests exclude stored thinking and binary payloads, decode text attachments, and mark omitted binary content.
- Linked summarizers use their own model/settings and ordinary scheduling. The parent yields compute without consuming active time. Same-model compaction for an interactive parent can inherit interactive admission. Recursive child compaction is disallowed.
- Compactor admission counts the fully annotated input against the child's context and output reservation. Oversized history is partitioned at complete exchange boundaries; each checkpoint covers only what was actually summarized. An exchange that cannot fit produces a diagnostic rather than silent truncation.
- Summary targets are bounded by available context and a 4096-token ceiling. Thinking shares the child's generation budget, so reasoning and visible-summary reservations are handled separately.
- Current structured summaries contain `objective`, `decisions`, `findings`, and `nextActions`, each an array of `{text, sources}` bullets. Source references are generated from original evidence and checked before adoption.
- Structured checkpoints keep source metadata, while resumed context receives Markdown summary bullets without restored source excerpts. Older plain-summary checkpoints use their retained evidence restoration path. Neither path proves summary accuracy.
- Executable handlers use their versioned JSON summary protocol from `src/engine/compaction/format.ts`. Existing plain-summary formats remain supported; arbitrary prose is not extracted as JSON.
- Agent summary failures have bounded `compaction.maxRetries` (default 1, range 0–2). Executable compaction is not automatically retried. Failed children and diagnostics remain recorded.
- Missing handlers, impossible retained input, or exhausted summary retries hold the parent at `contextFull`. Preparation/runtime failures use `runtimeError`. Resume the parent after correcting the cause; it coordinates its child. Cancellation cancels unfinished child work.
- Compaction preserves transcripts and invalidates incompatible KV generations. It does not reclaim transcript disk space or compact transient instant requests/audio inference.
- `contextUsage` reports the latest measured input/output counts, capacity, time, and turn. It is not a cumulative token total or proof that model memory is still resident.

## Transcript storage limits

- `storageLimitMB` defaults to 48 and accepts 1–48. It measures serialized run data, including attachments and events, rather than tokens.
- Admission/execution boundaries enforce byte and collection limits. A storage pause records the exhausted resource, usage, and maximum. New submissions are rejected while held.
- For byte limits, raise the configured limit where possible and explicitly resume. Increasing MB cannot resolve a collection-count ceiling. Resume rechecks capacity.
- No automatic transcript deletion, partitioning, rollover, or pruning occurs. Exporting or compacting a run does not free its stored history.

## Hooks

- Lifecycle events are `run.completed`, `run.failed`, `run.invalidOutput`, `run.timedOut`, `run.cancelled`, and `run.storageLimit`.
- Each configured hook has a stable `hookID` and purpose (`notification` or `delivery`). It receives one JSON line with event/run/agent/turn identity, state, result/error, event sequence, and receipt identity. Storage-limit hooks also receive the limit evidence.
- The hook start is recorded before execution. Repeated scheduling of the same hook/event does not dispatch it again. Receipt outcomes remain reviewable; hook retry commands and internal retry execution are removed.
- A storage hook runs after the hold is saved and does not unpause the run. Hook stdout is ignored, not interpreted as a summary.
- Hooks use bounded execution and a minimal environment. Uncertain started invocations become `unknown` after restart and are not replayed. Recorded dispatch is not a guarantee of exactly-once external delivery, especially if a crash loses an unsaved write.
- Scheduler hooks, compaction executables, and eval graders have their own request/result protocols. Custom eval checks do not gate ordinary production completion.

## Supervisor review and recovery

- `runs pause` holds queued work or interrupts active work. `runs resume` releases a paused run after its blocking condition is corrected.
- `runs retry` repeats the last user input in the same transcript using a new client message UUID and a note. It requires a terminal non-compactor run with no pending input and explicit confirmation. It can repeat side effects, so inspect uncertain outcomes first.
- `runs refresh` adopts current tool/skill definitions in a terminal run without pending input. It preserves model, prompt, history, and execution state; it invalidates the old context measurement. Earlier configuration events own snapshot history, while refresh metadata records time, turn, and source revision.
- The portable supervisor example produces an advisory Markdown report. Its `finishSchema` governs output shape; custom coverage checks belong in its eval grader. The production exporter renders/saves reports without a separate coverage gate.
- Supervisor findings are leads for review, not automatic factual verification or permission to change agents. Installed examples are not overwritten by package upgrades.

## Evals

- Eval definitions seed an ordinary run with a starting transcript and exact/default tool responses, optionally overriding agent generation settings. They use the selected agent/model, ordinary execution limits, continuation, and compaction.
- Mock tools never fall through to production execution. `finish` cannot be mocked. Lifecycle delivery hooks are suppressed; compaction handlers still execute.
- Hidden grading first checks an optional expected schema, then an optional executable. Schema failure skips the executable. Neither overrides `finishSchema` or provides repair feedback. Without a grader, the result is ungraded.
- Evals provide CRUD/run operations, tool-response editing, and transcript editing. Use transcript `set` with `messages: []` to clear a seed.
- See [eval format](eval-format.md) for executable grading, snapshots, and precise authoring behavior.

## Run records

- Each run owns `runs/<runID>/state.json`, format 10, replaced atomically through the shared storage queue. There is no journal or multi-file transaction; unsaved progress may be lost on crash.
- Metadata holds identity, revision, timestamps, current turn, execution, and active time. Messages hold conversation content and per-message attachments.
- Configuration snapshots, queued turns, attempts, compaction, validation, grading, and hook invocations live in typed events. The latest configuration event supplies admitted capabilities; its fingerprint validates that snapshot.
- Results, attempts, queued inputs, and receipts in detail/export views are derived. Result text comes from the accepted assistant message rather than a second persisted copy.
- Generation checkpoints update partial progress without writing an event for every token. Event UUIDs and public transcript cursors remain stable; public sequence counts lifecycle events separately from storage events.
- Recorded tool results suppress re-execution. Unresolved started external calls are held for review; restart does not guess whether a side effect happened. Compaction retains child/checkpoint identity.
- Normal readers accept current disk formats only. Stop the daemon, preview `node dist/storage/migrate.js --home ABSOLUTE_HOME`, and add `--apply` for an authorized migration. The offline migrator accepts run formats 3–9, preserves originals, and does not replay tools/hooks. Configuration migration produces format 5.
- Older migrations flattened some history. Snapshots found only in retired fields remain in original-run backups; current configuration events are preserved.

## Operations and validation

- `daemon` owns service installation, foreground execution, lifecycle control, and operational logs. Uninstalling it does not delete runtime data or models.
- `status` reports fleet/runtime state; `daemon status` reports process/service state. `status --doctor` checks readiness without inference and works with the daemon stopped. Inspect `healthy` and individual checks, not just command success.
- Operational JSONL logging is optional, severity-filtered, rotated, and bounded. Logs contain additional daemon diagnostics, not content or facts already available in run records.
- `runs export` creates a new private bundle with checksums. `runs verify` checks schemas, identities, ordering, references, and bundle consistency without executing tools. Checksums detect corruption, not authenticity or factual correctness.
- `--wait` submits once and observes completion; timeout/disconnection does not cancel accepted work. Errors after acceptance retain the accepted ID. `--tail` follows committed transcript events or log offsets and rotation.
- Waits default to 120 minutes; tails have no default deadline. Explicit observation timeouts are bounded independently of agent execution limits.
- See the [validation guide](acceptance.md) for mocked checks, opt-in real-model tests, and evidence requirements. Current instructions make no claim that an older live result validates this release.
