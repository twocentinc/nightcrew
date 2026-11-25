# Agent evals

Eval fixtures and TypeScript graders live alongside their agents:

- [Summarizer](../summarizer/README.md): preserve confirmed facts and timestamps.
- [Agent supervisor](../agent-supervisor/README.md): distinguish historical failures
  from current problems and cover priority incidents.

Each directory contains `eval.json`, `eval.ts`, `grade.ts`, and `test.ts`.
The supervisor also keeps deterministic inspector/exporter tests in `test.mjs`.
Core eval runner tests stay in `test/evals.test.mjs`.

The model sees synthetic fixtures; executable tools are intercepted. Graders run
after each case and leave semantic judgments marked for review. See the
[eval format](../../docs/eval-format.md) for the protocol and runtime limitations.
