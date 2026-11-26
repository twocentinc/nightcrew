# Nightcrew

- Run local-model agents while you are away, then review their work when you return.
- Give each agent its own prompt, model, tools, skills, limits and schedule.
- Prioritize interactive requests; pause background work until the interaction cooldown expires.
- Manage everything through a JSON-first CLI or the optional HTTP API.
- Keep transcripts, configuration and caches in your runtime home, separate from this repository.
- Current release: **0.44.0**, protocol **1**, schema **45**. See the [compatibility policy](docs/compatibility.md) before upgrading or changing public contracts.

## Get started

- Install **Node 22.12+** and a compatible `llama-server` on `PATH`.
- Use macOS for unattended operation: LaunchAgent management and desktop presence are macOS-specific.
- Supply your own model weights. Nightcrew does not download models.
- Build the CLI from this checkout:

  ```sh
  npm ci
  npm run build
  node dist/cli.js help
  node dist/cli.js init
  node dist/cli.js status --doctor
  ```

- Install or link the package to use the `nightcrew` executable; otherwise substitute `node dist/cli.js` in the examples below.
- `init` creates an empty configuration and returns the HTTP root token **once**. Store it in your client's secret storage.
- Defaults: `~/.nightcrew`, loopback port `6970`, HTTP enabled, five-minute interaction cooldown.
- Select a different runtime home with `--home /absolute/path` or `NIGHTCREW_HOME`; the flag takes precedence.
- Register a model, then an agent. Start with the [bundled examples](examples/README.md); initialization does not install them automatically.

## Discover commands and request shapes

- `nightcrew help` — everyday commands.
- `nightcrew help --advanced` — all commands, including recovery and diagnostics.
- `nightcrew help agents run` or `nightcrew agents run --help` — one command's options.
- `nightcrew schema get agents.create` — its JSON request schema.
- `nightcrew schema get agents.create.result` — its result schema.
- `nightcrew version` — package, protocol and schema versions.
- Pass structured input with `--request request.json` or `--request -` for stdin.
- Use `--dry-run` to preview supported mutations; commands marked as requiring confirmation in help also require `--yes`.
- Commands never prompt. `--no-input` makes that intention explicit.
- Commander owns option parsing: unknown flags are rejected, grouped short aliases work, and repeated options use the last value.

## Manage the daemon

- `nightcrew daemon install --dry-run` — preview the per-user LaunchAgent.
- `nightcrew daemon install` — install it.
- `nightcrew daemon start`, `stop`, `restart` — manage the selected service.
- `nightcrew daemon status` — inspect service registration and process status.
- `nightcrew daemon run` — run in the foreground; SIGINT/SIGTERM shuts down gracefully.
- `nightcrew daemon uninstall --yes` — remove service registration without deleting runtime data or model weights.
- `nightcrew daemon logs --lines 100` — inspect recent operational logs.
- `nightcrew daemon logs --tail` — follow new lines and log rotation.
- The LaunchAgent uses absolute Node/CLI paths and an explicit `PATH`; it does not load shell startup files.

## Configure models and agents

- Agents, models, skills, tools and triggers provide `list`, `get`, `create`, `update` and `delete` commands.
- Use the generated schemas for exact request fields; for example:

  ```sh
  nightcrew config get
  nightcrew schema get models.create
  nightcrew models create --request model.json
  nightcrew schema get agents.create
  nightcrew agents create --request agent.json
  ```

- Agent and trigger updates use their own `expectedRevision`.
- Configuration and model updates use the configuration's `expectedRevision`.
- Skill and tool updates/deletes use `expectedHash` from the current resource.
- Referenced resources cannot be deleted until their references are removed.
- Set `scheduler.instantModelID` to the chat model serving interactive requests.
- Configuration changes use the daemon's private socket when running, or its exclusive storage lock when stopped.
- Changes requiring different compute capacity or model settings may require idle work; listener changes report `restartRequired`.
- New runs snapshot their agent, tools and skills. Editing definitions does not silently rewrite existing run snapshots.
- After editing skill/tool files directly, use `nightcrew config reload`. CLI CRUD refreshes them automatically.
- See [configuration and resources](docs/spec.md#configuration-and-resources) for the full contract.

## Run agents and inspect their work

- Submit a turn with `nightcrew agents run AGENT_ID --request turn.json`.
- Generate a fresh message UUID for every new turn. Reusing an accepted UUID deduplicates the submission; changing its input causes a conflict.
- Put content, attachments and an optional thinking override on the message:

  ```json
  {
    "message": {
      "messageID": "ed98a13e-a364-41db-b5c8-47cb4b69a12c",
      "content": "Review the available information and write a report.",
      "attachments": [],
      "thinking": false
    }
  }
  ```

- `nightcrew status` — fleet outcomes, work needing attention, presence, cooldown and model state.
- `nightcrew status --details` — include scheduler allocations and its last decision.
- `nightcrew runs list --agent AGENT_ID --state completed --limit 20` — filter runs.
- `nightcrew runs get RUN_ID` — inspect state, outcome and recovery evidence.
- `nightcrew runs transcript RUN_ID --tail` — follow committed transcript events.
- `nightcrew runs search "search phrase" --agent AGENT_ID` — search recorded text.
- `nightcrew runs reply RUN_ID --request turn.json` — add another turn.
- Add `--wait` to `agents run` or `instant create` to observe completion after submitting once.
- A wait timeout, Ctrl+C or closed CLI **does not cancel accepted work**. Inspect the returned `acceptedID`; do not resubmit blindly.
- Run pagination defaults to 50 items, maximum 100. Reuse the same filters and limit with a returned cursor; daemon snapshot cursors expire after five minutes or a restart.

## Schedule background work

- Create a trigger with `nightcrew triggers create --request trigger.json`.
- Choose a schedule: manual, fixed interval (`everyMs`, minimum one minute), or cron (`expression` plus explicit `timezone`).
- Cron syntax, calendar validation and DST behavior follow **cron-parser**, including optional seconds, named fields and predefined expressions.
- During DST changes, skipped local hours may run at the landing hour; forward iteration suppresses repeated hours.
- Missed timer occurrences are **never caught up**. Restart begins with the next future occurrence.
- `nightcrew triggers fire TRIGGER_ID` submits a saved trigger now without shifting its schedule.
- Supply a stable `occurrenceID` UUID when retrying a trigger submission; omitting it creates a new occurrence each time.
- Queue policies: `skip` avoids overlapping unfinished work; `enqueue` preserves submissions; `coalesce` combines eligible work that has not started.
- Disable an agent or trigger through its revision-checked `update` command. Disabling a trigger stops future submissions, not accepted runs.
- Pending work is stored in runs; there is no separate queue database.

## Presence, priority and interactive work

- Background work requires healthy desktop-away detection **and** an expired interaction cooldown.
- On macOS, a locked session, switched-out user or ten minutes without input counts as away.
- `nightcrew presence sample` reads the local desktop without requiring a daemon; `status` shows the daemon's latest sample.
- Unhealthy presence blocks background work. Other platforms do not have equivalent validated unattended support.
- `nightcrew instant create --request chat.json --wait` requests an interactive response.
- `nightcrew instant get REQUEST_ID` and `instant delete REQUEST_ID` inspect it or cancel and discard its transient result.
- Instant work pauses background generation and waits for compute to release before starting.
- Completion refreshes the interaction cooldown; its default is five minutes and is configurable.
- Only one model is resident at a time. Compatible background agents can run concurrently on separate slots when `maxConcurrent` permits it.
- Model/agent priority, residency preference and wait aging guide the default scheduler.
- `nightcrew scheduler explain` inspects its decision without dispatching work.
- An optional executable scheduler hook can propose a plan; Nightcrew still enforces presence, cooldown, capacity and model safety.
- See [scheduling and triggers](docs/spec.md#scheduling-triggers-and-interactive-work) for configuration and hook details.

## Context, thinking and persistent agents

- `contextMode: "fresh"` starts each run with fresh context; `"persistent"` keeps one run ID and transcript across invocations.
- Persistent agents restore a named KV checkpoint into a shared physical slot; they do not reserve permanent slots.
- `timeoutMs` limits active work. Paused time does not count; persistent segments also yield according to `timeSliceMs`.
- Configure `thinking`, `temperature`, `maxOutputTokens`, optional `sampling`, and an optional `maxToolCalls` budget per agent.
- A message's `thinking` override applies to that turn and its tool loop. Omission uses the run's snapshotted agent default.
- Thinking traces, partial answers and interrupted attempts remain reviewable separately from completed answers.
- Output-limit continuations retain evidence; incomplete tool calls are never executed.
- Enable model `slotSnapshots` to save caches before model switches, idle unloads and clean shutdowns.
- Snapshot storage defaults to `<home>/slots/<modelID>`; model configuration can choose another absolute base directory.
- `nightcrew agents get AGENT_ID` includes cache information; `agents cache delete AGENT_ID --yes` clears KV state without deleting its transcript.
- Caches are disposable acceleration. Missing or incompatible caches rebuild from the authoritative transcript.

## Compaction and storage limits

- Set a model's `compactionThresholdTokens` and select an agent's compaction handler: a separate summarizer agent or an executable script.
- Nightcrew counts the assembled input and reserves room for output before generation. Configure context capacity larger than the output reservation.
- Compaction replaces older **model-visible context**, not the stored transcript. The parent continues under the same run ID.
- Linked summarizer runs use their own model and settings; the parent releases compute while waiting.
- Failed summaries have bounded recovery. Exhausted retries hold the parent at `context_full`; preparation failures use `runtime_error`.
- Persistent runs pause at their configured transcript storage limit, up to 48 MB. Compaction does not reclaim transcript disk space, and there is no automatic rollover.
- Instant requests and audio inference are not automatically compacted.
- See [context compaction](docs/spec.md#context-compaction), [storage limits](docs/spec.md#transcript-storage-limits), and the [summarizer example](examples/summarizer).

## Define tools

- Tools are trusted executables with an absolute `executablePath`, an object JSON Schema in `parameters`, and optional `argv` templates.
- Validated model arguments arrive as JSON on stdin; stdout must contain JSON.
- Map values directly into flags or positional arguments: `argv: ["runs", "transcript", "%runID%", "--limit", "%limit%"]`.
- `%nested.key%` and `%items.0%` select nested values; `%%` produces a literal percent.
- Each substituted value stays within one argument. No shell evaluation or recursive expansion occurs; missing values fail before launch.
- Wrappers remain useful for conditional flags, repeated arguments or non-JSON output.
- Tools default to a 10-second timeout, support 100–60000 ms, and have a 1 MB output limit.
- Tools receive minimal environment/context variables, not the daemon's root token or secret environment.
- Custom tools run with the local user's permissions. Nightcrew does **not** provide an OS sandbox or enforce read-only behavior.
- Bundled immutable tools: `load_skills`, `runs_list`, and `runs_transcript`.
- Ordinary tool failures become structured, nonfatal tool results. Unknown external outcomes are not automatically retried.
- Discover the full shape with `nightcrew schema get tools.create`; see [recoverable tool errors](docs/spec.md#recoverable-tool-call-errors).

## Define skills

- Store each skill under `<home>/skills/<skillID>/SKILL.md`, optionally with `references/` and `assets/`.
- Agents initially see only the names and descriptions of their configured skills.
- Agent loops receive `load_skills` automatically; instructions and supporting files enter context on demand.
- `{"skillIDs":["review"]}` reads instructions and a manifest; `{"files":[{"skillID":"review","path":"references/guide.md"}]}` reads a resource.
- Skill folders do not execute scripts merely because they contain them.
- Skills CRUD writes the folder. Updates omitting `files` retain current resources; an explicit array replaces the managed resource set.
- Resources are bounded; traversal and symlinks are rejected. See [on-demand skills](docs/spec.md#on-demand-skills) for limits and encoding.
- `nightcrew skills read --request selection.json` reads installed skills; include `runID` to read a run's snapshots.
- Instant chat can execute selected skill reads. Other client-defined tool calls remain the client's responsibility.
- Single-turn and audio agents remain tool-free.

## Review, recover and deliver results

- Inspect `status`, `runs get` and `runs transcript` before taking recovery action.
- A completed run can still have invalid output or failed delivery. Inspect its `outcome`; successful validation is not proof of factual correctness.
- `runs pause RUN_ID` holds work; `runs resume RUN_ID` releases a hold or resumes paused work.
- `runs cancel RUN_ID` stops work; `runs retry RUN_ID --yes` repeats the latest input as a new segment and may repeat tool side effects.
- Recovery commands use revision-checked JSON requests. Discover fields with `schema get runs.resume`, `runs.retry`.
- Restart never automatically replays uncertain delivery. Investigate the destination before repeating any side effect.
- Recover compactor children through their parent run.
- Invalid `finish` calls and rejected final outputs fail immediately, without automatic correction. Optional output validators gate completion. Hooks marked `purpose: "delivery"` contribute to the delivery outcome.
- See [review and recovery](docs/spec.md#supervisor-review-and-recovery) and [hooks](docs/spec.md#hooks).

## Export and verify

- `nightcrew runs verify RUN_ID` checks run structure without executing tools or repairing files.
- `runs export RUN_ID --request export.json` takes `{"destination":"/absolute/new-bundle"}`; the parent directory must exist and the destination must not.
- Bundles contain the run, transcript, snapshotted configuration, result and a SHA-256 manifest.
- `runs verify RUN_ID --request verify.json` takes `{"bundle":"/absolute/new-bundle"}` to verify an exported bundle.
- Export/verification work offline. Bundles include prompts, tool results and attachments, so treat them as private data.
- Inspect `valid`, `checks` and `errors`; a successful command can report failed verification. Checksums detect corruption, not authenticity.

## HTTP, files and logs

- `GET /openapi.json` describes the generated HTTP API; health and OpenAPI are public.
- `/v1/*` requires the shared root bearer token. `nightcrew config token rotate --yes` replaces it and returns the new value once.
- Set `httpEnabled: false` through `config update` and restart to use only the private local CLI socket.
- CLI and HTTP share oRPC contracts. TypeScript clients can import `ManagementRouter` from `nightcrew/operations`.
- Configuration lives in `<home>/config.json`; each run owns `<home>/runs/<runID>/state.json`.
- Instant request state is memory-only and expires 15 minutes after termination.
- Operational JSONL logs live under `<home>/logs`; levels are `off`, `error`, `warn`, `info`, and `debug`.
- Defaults retain three 1 MB files at `warn`. Change `logging` through revision-checked `config update`.
- Logs contain daemon operational evidence, not prompts, responses, thinking, tool payloads or facts already recorded in transcripts.
- CLI diagnostics go to stderr; use `--verbosity verbose`, `--verbosity debug`, or `--quiet` independently of daemon logging.

## Automate safely

- Finite commands emit one JSON envelope on stdout, including failures; tails emit JSONL batches.
- Use `--request-id ID` to correlate work. Errors include `code`, `message`, `details`, `exitCode` and `retrySafety`.
- `safe` permits retry without an ambiguous mutation; `unsafe` requires inspection first; `never` requires resolving the request or reported condition.
- Ordinary finite commands default to 90 seconds, maximum five minutes. Durations accept `ms`, `s`, or `m`.
- Waits default to 120 minutes and allow up to 1440 minutes; tails run until interrupted unless given a timeout.
- `evals run ID` submits ordinary queued work; `--wait` observes completion and grading with the same deadline behavior as `agents run --wait`.
- `status --doctor` checks configuration, references, dependencies and daemon readiness without loading models. It also works when the daemon is stopped.
- Diagnostic success does not imply health: inspect the returned checks and `healthy` fields.
- Exit codes: `0` success; `1` internal/result failure; `2` invalid input; `3` configuration/storage; `4` platform; `5` dependency; `6` deadline; `7` unavailable resource; `8` confirmation; `9` conflict.

## Examples, evals and development

- Copy and customize [examples](examples/README.md), including [hello world](examples/hello-world), [summarizer](examples/summarizer), and [agent supervisor](examples/agent-supervisor).
- Application-specific agents, tools and delivery scripts belong outside this repository.
- Use `evals create --file eval.json` and `evals run ID --wait`; edit fixtures with `evals tools` and `evals transcript`. Evals use regular runs, model selection, compaction and `finish`, with mocked tool results and optional schema-then-executable grading. See the [eval format](docs/eval-format.md).
- `npm run lint` — strict type checks for source, tests and examples.
- `npm test` — mocked runtime, example and contract tests; no production-model inference.
- `npm run test:package` — pack, install and verify the CLI, exports and examples in a temporary directory.
- `npm run contracts:check` — verify immutable contract snapshots.
- `npm run contracts:update` — explicitly update snapshots after an approved schema change; the helper lives in `test/contracts.ts`, and normal tests never rewrite snapshots.
- `npm run test:live` — opt-in real-model checks; read the [acceptance guide](docs/acceptance.md) first.
- See [model-switch verification](docs/model-switch-verification.md) for measured results and their limits; mocked tests do not establish model quality or crash-recovery acceptance.

## Source map

- `src/cli.ts` — executable entry point and finite command execution.
- `src/commands/` — **only top-level CLI command families**, with their schemas, metadata and handlers.
- `src/utils/commands/` — shared command discovery, oRPC procedures, dispatch and resource transactions.
- `src/engine/` — runs, generation, tools, scheduling, models, compaction and evals.
- `src/schemas/` — shared contracts and validators.
- `src/storage/` — configuration, transcripts, atomic files and derived indexes; one shared transaction queue.
- `src/server/` — HTTP hosting, control socket, LaunchAgent and operational logs.
- `src/utils/` — small general-purpose helpers such as canonical JSON.
- [Specification](docs/spec.md) — detailed ownership and behavior.
- [Compatibility policy](docs/compatibility.md) — public contract and upgrade rules.
- [AGENTS.md](AGENTS.md) — contributor and coding-agent instructions.
