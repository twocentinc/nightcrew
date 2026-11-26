# Agent supervisor

A portable, read-only operational reviewer for any Nightcrew installation. Ships
in the examples distributed with Nightcrew; `init` does not activate it. No
application integration, network service or particular model is required. A larger
supervising model reads its Markdown report and decides what to do. The worker
cannot change configuration, retry/cancel runs or send messages.

## Install

Copy this directory to a durable local directory. Set `agent.json` modelID to a
registered chat model and compaction.handler.agentID to an installed single-turn
summarizer (or disable compaction). In `tool.json`, replace executablePath with
your absolute Node executable and argv[1] with the copied inspect.ts path; retain argv[0],
`--experimental-strip-types`, for Node 22.
Register tool, skill, agent, and manual trigger through the existing CLI:

```sh
nightcrew tools create --request tool.json
nightcrew skills create --request skill.json
nightcrew agents create --request agent.json
nightcrew triggers create --request trigger.json
```

The example definitions are disabled. Enable the agent and trigger explicitly
when ready using `agents update agent-supervisor` and
`triggers update agent-supervisor-manual`, each with a request containing the
current `expectedRevision` and `changes: {"enabled": true}`. The schedule remains manual;
there is no timer. Run with `nightcrew triggers fire agent-supervisor-manual`.
No example-specific installation command is needed.

Register report.ts as a run.completed notification hook using revision-checked
`config update`, preserving existing hooks. Make it executable; its shebang uses
`node --experimental-strip-types` and requires Node on the daemon PATH. Hook fields are event, purpose, executablePath,
and timeoutMs (10000 is sufficient). It ignores other agents and writes exact
results to `~/.nightcrew/integrations/agent-supervisor/reports/<runID>.md`.
For a nondefault home, use an executable wrapper importing `report` and passing
the explicit home; lifecycle hooks do not inherit NIGHTCREW_HOME. The inspection
tool receives NIGHTCREW_HOME from the tool runner automatically.

## Review boundaries

`inspect.ts` accepts overview, page (five metrics per page), and run (bounded
failure detail for a run in this snapshot). It never reads config, credentials,
arbitrary paths, prompts, thinking, tool arguments or raw tool results. Run error
messages and failure event evidence may contain private operational details;
reports and snapshots use private permissions. The reader derives metrics from
run state; duplicate call detection hashes exact arguments and reports counts,
not their contents. Repeats and failed hook attempts are investigation leads,
not automatic proof of a bug or failed final delivery.

The first review includes runs updated in the last 24 hours plus older held or
failed/timed-out runs. Later reviews select changed revisions within that baseline
and outstanding failures. Supervisor runs are excluded. Snapshots cap at 1000
runs, prioritize held/errors and disclose omitted/unreadable runs. Tool/context
budgets may leave pages unread; the report must disclose that. A completed report
checkpoints only revisions whose metrics pages were returned. This is an
inspection checkpoint, not proof that every transcript was reviewed. Revisions
changing after snapshot stay eligible next time. Successful report export precedes
checkpoint advancement; exports are create-only and idempotent for identical text.
Keep one supervisor run at a time (manual trigger queuePolicy skip).

No general semantic or factual correctness check is claimed. Start manually and
review its reports before adding any schedule. Package updates do not overwrite
installed copies. Tests use synthetic run homes and require no inference.

Current operational evidence is grouped under `current`: execution, active holds,
latest segment validation, effective delivery retries, and the linked parent's
state. `historical` keeps failure counts and retained errors for context. A
successful retry supersedes its failed attempts; a child whose parent finished
or no longer awaits it is stale cleanup, not a blocked parent. Missing parent or
receipt scope is explicitly unverified. Reviewer notes are dated observations,
not overrides of newer state. Hook success alone does not prove external delivery.

Reports separate current problems from recovered/historical observations. Tool
responses include exact coverage counts for unique summary pages and detailed
runs; the worker must use these rather than estimate. Detailed reads refresh
current state and disclose the frozen snapshot revision for comparison.

The inspector reads canonical outcomes through `nightcrew runs list/get` on PATH.
It adds counts and review coverage without reconstructing hook retry status.
Changed revisions during snapshot collection are reported as unreadable, not
classified from mismatched evidence.

Configure the agent output-validation hook with your Node path and copied
`report.ts --validate` path. The inspector repeats recent priority incidents
in every response; reports need one `### RUN_ID` section for each with exact
Execution, Output and Delivery status lines, an Assessment and a Next action.
If the snapshot file is absent, validation uses the recorded successful overview
tool response from the run transcript. This supports eval tool overrides without
requiring simulated filesystem writes or weakening coverage checks.
The validator checks coverage, not semantic accuracy. Recent unresolved incidents
remain visible after checkpoints, while capability refresh alone is not a new
incident. The exporter rejects incomplete coverage before saving/checkpointing.

## Colocated evals

- `eval.json` is one saved eval definition; additional `eval-*.json` files are independent scenarios.
- Install this agent and its model/capabilities first. Evals keep its real finish contract and run through the ordinary scheduler.
- `grade.ts` checks the example's deterministic criteria; a passing check is not a general factual or semantic review.
- `eval.ts` resolves the optional TypeScript grader to absolute paths. It does not run inference.

```sh
node --experimental-strip-types examples/agent-supervisor/eval.ts > /tmp/eval.json
nightcrew evals create --file /tmp/eval.json
nightcrew evals list
nightcrew evals run EVAL_ID --dry-run
# Explicit real-model evaluation:
nightcrew evals run EVAL_ID --wait
```

Pass another fixture file to `eval.ts` to install a different scenario. Inspect the returned run ID with `runs get` and `runs transcript`. See [the eval contract](../../docs/eval-format.md).
