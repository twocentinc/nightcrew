# Converted regression evals

These preserve scenarios from existing unit tests, while asking the model to
produce an answer. They complement the original tests; they do not replace them.

| Suite                         | Source                           | Model behavior evaluated                                                                                                      |
| ----------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `compaction-regressions.json` | `test/compaction.test.mjs`       | Preserve a confirmed budget and pending work; do not reinterpret timestamp digits as counts. Two independent tool-free cases. |
| `supervisor-regressions.json` | `test/agent-supervisor.test.mjs` | Read mocked inspector results and distinguish tool errors, repeated arguments and compaction retries. One agent-loop case.    |

The installed agents must be named `summarizer` and `agent-supervisor`, respectively.
The supervisor fixture includes synthetic skill, overview, page and run detail
responses. No real inspector tools run. Its metrics were constructed using the
same metrics function exercised by the unit tests.

Literal and JSON assertions provide mechanical checks. Semantic criteria require
review of the saved context, trace and answer; passing mechanical checks alone is
not proof of a correct summary or diagnosis.

See [the eval format](../../docs/eval-format.md#running-a-suite) for validation,
dry-run, execution and result interpretation. Use a new destination per run.
