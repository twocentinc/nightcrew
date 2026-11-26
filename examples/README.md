# Examples

These are ordinary Nightcrew request files, not an installed configuration.
Nothing is copied or enabled by `nightcrew init`. Copy and edit the files, then
use the existing CLI. Installed definitions belong to you; package updates do
not overwrite them. Examples ship with automatic dispatch disabled and remain
manually runnable.

Start with [hello world](hello-world/README.md), a single-turn agent with no tools
or skills. It demonstrates model/slot selection and a per-turn thinking override.

[Granite transcription](granite-transcription/README.md) demonstrates a
single-turn audio agent and WAV attachments, with no bundled private recordings.

[Run summarizer](summarizer/README.md) provides a compaction agent with no tools,
a researched handoff prompt, and a synthetic evaluation turn. It can be referenced
by another agent's compaction handler without adding a recurring trigger.

- [Agent supervisor](agent-supervisor/README.md): portable read-only run metrics,
  operational evidence, Markdown handoffs and incremental review checkpoints.

## Eval fixtures

[Converted regression evals](evals/README.md) exercise summarizer and supervisor
answers through ordinary runs with eval tool overrides.
