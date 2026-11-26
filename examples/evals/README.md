# Agent evals

- Example-specific eval definitions, TypeScript graders and grader tests live beside each agent: [hello world](../hello-world/README.md), [summarizer](../summarizer/README.md), [supervisor](../agent-supervisor/README.md).
- Each JSON definition represents one ordinary run with mocked tool results and optional grading. Extra scenarios use separate `eval-*.json` files.
- `eval.ts` prints a portable fixture with its grader executable paths resolved for this installation; create it with `evals create --file`.
- Generic eval engine/CLI tests remain in `test/evals.test.ts`. These use a fake runtime and do not load a model.
- See [the eval format](../../docs/eval-format.md) for schemas, commands, grading order and executable protocol.
