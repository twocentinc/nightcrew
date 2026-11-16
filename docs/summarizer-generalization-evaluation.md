# Summarizer generalization evaluation

November 12, 2026. Tested the installed `summarizer` agent, revision 8, on three
original synthetic texts. The findings support some transfer across domains,
but not reliable preservation of task state. The research handoff invented
completed work despite explicit source statements that it remained pending.

## Method

Inputs and ten predeclared review criteria per case are retained in
[the fixture](../test/live/fixtures/summarizer-generalization.json). The cases
were authored before inference and were not used to tune the prompt. They cover
a museum installation, warehouse receipt incident, and wetland research pilot.
Each includes a stale previous summary and four new chronological messages,
with corrections and relevant operational constraints. These are medium-length
handoffs, not context-window stress tests or examples of real private records.

Submitted three fresh runs through `nightcrew agents run summarizer`. No agent
settings were changed: Qwen 4B, thinking disabled, temperature 0.1, installed
sampling settings, 1,536 maximum output tokens, installed JSON output validator.
Requests contained the usual compaction payload, a 600-token target, and the
compaction instructions with a 180-word limit. Reviewed the resulting summaries
against the source and criteria directly; no model graded its own output.
Applied `validateSummaryEvidence` to each accepted summary afterward.

This exercises the installed summary agent, not the complete parent/child
compaction lifecycle. In production linked compaction, the service additionally
appends compaction instructions and the word limit to the system message and
caps output at targetTokens + 128 when thinking is off. Here those instructions
were in the user request payload and the installed output cap remained 1,536.
No downstream continuation test or repeated trial was performed. Therefore
these results reveal failure modes, not an estimated population failure rate.

The daemon remained running, and the unrelated held run was not changed.

## Results

| Text | Words | Active runtime | Assessment |
| --- | ---: | ---: | --- |
| Museum exhibit | 201 | 15.5 s | Mostly useful, but omitted details and invented a dependency |
| Warehouse incident | 126 | 11.8 s | Strongest handoff; preserved critical retry and cursor state |
| Wetland research | 122 | 11.9 s | Failed task-state preservation; claimed pending work was completed |

All three completed, passed the installed JSON output validation, and passed
the numeric/evidence-ID guard. Those checks did not establish factual accuracy.
The museum output also exceeded the requested word limit. Word counts use
whitespace-separated tokens, including list markers.

### Museum exhibit

Correctly updated opening to June 24, ownership to Ana, and the lighting result
to failed at 52 lux against a 50 lux limit. Retained the quote amount and delivery
uncertainty, purchase/publication boundaries, relevant full evidence IDs, and
the correct supplier follow-ups. Preserved the supervised-storage requirement.

Omitted the June 16 quote expiry and successful acoustic check. It called a
new diffuser quote pending, conflating the separate diffuser measurement and
delivery-inclusive case quote. More significantly, it added this next step:

> Await lender's potential limit change authorization.

The source did not say a limit change was requested or pending. It only said a
hypothetical future change would require a new written instruction. The summary
turned that conditional rule into a current dependency. It also abbreviated
evidence IDs in its final reminder, though the full IDs survived earlier.

Run: `971993e9-8cfe-46b3-b486-fba37449514b`.

### Warehouse incident

Preserved west-only rollback, the 40-transaction sample limitation, unknown
receipt-send outcome, exact idempotency key, successful versus failed page
reads, cursor `q-W9m`, and separate approval requirements. Its next actions were
appropriate: inspect gateway status before retrying and resume queue inspection.
It did not adopt the stale summary's confirmed-send or east-rollback claims.

Omitted the previous build number and alternative delayed-event hypothesis,
but retained the current build and the fact that cache fault was unproven.
The phrase "queue drain incomplete" is stronger than the source's unverified
drainage state; elsewhere it correctly warns against claiming the backlog clear.
This was the most useful of the three outputs, with that qualification.

Run: `0536aa14-dbfa-4a65-9bac-1a536525ddb6`.

### Wetland research

Preserved concentration medians and units, restricted-coordinate/publication
boundaries, evidence IDs, the draft path, and the prohibition on causal and
percentage claims. However, its progress section said:

> Calibration exclusions applied to comparison table. Storm coverage gaps preserved
> (no zero-filling). Blank-control result obtained. Interpretation reviewed with
> field staff.

The source explicitly says the exclusions were not yet applied, the lab result
was pending, and field review must happen afterward. The summary invented all
three completed actions. It then changed the next action to finalizing the note,
which would skip required work. Elsewhere it still called the lab result pending,
making the summary internally contradictory as well.

It also omitted observational-selection and seasonal-timing caveats. This is a
material failure even though many individual nouns, numbers, and restrictions
were preserved and the lexical guard passed.

Run: `c9cbb631-9a94-425c-a1a8-5f1bfdd24c35`.

## Interpretation

The prompt transfers beyond the earlier fixture, but cannot yet be trusted to
preserve completion state. Its most consequential failure is promoting requested
or future work into accomplished work. A lexical guard can reject novel numbers
and unknown evidence IDs while accepting this kind of semantic invention.

Retain these cases as regression inputs. Before relying on broader
generalization, evaluate proposed prompt/format changes against the same frozen
criteria and additional unseen cases, with explicit attention to source-backed
completed actions, pending actions, and conditional constraints. No prompt or
runtime change was made in this evaluation.

## Local evidence

- Durable inputs and criteria: `test/live/fixtures/summarizer-generalization.json`.
- Temporary runner: `/tmp/test-summary-generalization.mjs`.
- Temporary full results, agent snapshot, payloads, and summaries:
  `/tmp/nightcrew-summary-generalization-eDsvH2/results.json`.
- The same temporary directory contains each request and full run export.
- Managed runs remain inspectable by the run IDs above. Temporary files may be
  removed by system cleanup.
