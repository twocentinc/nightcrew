# Historical acceptance results

These are dated records from older implementations, not acceptance claims for the current release. For current procedures, see [the validation guide](../acceptance.md).

## November 16, 2026 review

Version 0.31.1 passed the above checks using Qwen 4B for instant requests,
Qwen 9B for background work and compaction, and Granite for synthetic speech.
The cycle resumed from its saved priority/restart checkpoint after replacing an
empty audio fixture; the original rejected input and successful run are retained.

The live cycle exposed a completion-publication race: instant requests could
appear completed before their renewed cooldown had been persisted. Completion is
now published after persistence. A focused regression holds the save pending and
asserts that clients cannot yet see terminal completion. The repeat live phase
verified the post-response cooldown before background resumption.

Independent review checked the actual saved compaction summary and resumed
answer against the synthetic source facts, plus successful runtime KV restore
operations and exact local report contents. The review also corrected tail
backpressure and terminal-run classification in the supervisor example. No claim
is made about an overnight production soak or external Discord delivery.

### November 23, 2026 result

The real-Qwen SIGKILL fixture passed generation, linked-agent compaction and
ambiguous multipart delivery recovery. Generation retained one user message and
one final assistant answer. The interrupted compactor reused its run and produced
one checkpoint; the resumed parent recalled lavender, seven trees and a blue gate.
The local receiver accepted two distinct message parts and saw no duplicate after
restart or a suppressed retry. Delivery remained unknown for manual review.

The first test exposed an orphaned llama.cpp process after owner death. The
owner-pipe guard fixes that for the model server and lifecycle hooks. The final
pass checked the complete descendant tree at each crash (three, five and five
processes) and found no survivors. No external Discord messages were sent.

The current core crash fixture uses a generic HTTP delivery hook. The earlier
multipart transport check belongs to the separately maintained integration;
Nightcrew itself owns the durable hook receipt and uncertain-outcome hold.
