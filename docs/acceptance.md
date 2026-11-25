# Unattended acceptance checks

From a source checkout, `test/live/acceptance.test.ts` is opt-in and excluded from the default test suite.
It uses actual model weights and the real desktop presence detector. Stop other
Nightcrew daemons first; never run competing model servers. The desktop must
already be away. Restore the normal daemon after the test, including on failure.

Provide a private JSON settings file containing:

- `instant`: a registered chat-model definition (tested with Qwen 4B).
- `qwen`: a background chat-model definition (tested with Qwen 9B).
- `granite`: an audio-model definition.
- `audioFile`: an absolute path to a short WAV saying “hello world”.

The test creates a private temporary home, prints its path, and retains
`acceptance.json`, run state, transcripts, local Markdown deliveries and slot
snapshots for independent review. Existing runtime state is not copied or edited.
No external messages are sent. A five-second test cooldown exercises the same
lifecycle as the installation's configurable cooldown without changing it.

```sh
NIGHTCREW_ALLOW_INFERENCE=1 \
NIGHTCREW_LIVE_CONFIG=/absolute/path/to/private-settings.json \
node --experimental-strip-types --test test/live/acceptance.test.ts
```

Checks include a real interval trigger, instant preemption and post-response
cooldown, background resumption, service restart during generation, Granite
transcription, successful Qwen KV restoration after switching back, compaction
through a separate agent, preservation of synthetic facts and local report
export. Successful KV restoration is observed at the runtime save/restore
boundary; recall alone is not treated as proof of cache restoration.

This is a controlled unattended cycle, not a substitute for an entire overnight
soak. The restart check closes and reopens the service; it does not simulate
power loss or a SIGKILL. Local report export is not proof of Discord delivery.
Supervisor reports are leads for a stronger reviewer, not automatic factual
validation or authorization to change agents.

A failed fixture can be corrected without repeating already verified inference:
set `NIGHTCREW_LIVE_RESUME` to the printed acceptance home. Resume is permitted
only after the priority/restart checkpoint and continues at audio/model-switching
validation. It renews only that private test home's temporary HTTP token. Review
the combined acceptance record and original failure logs rather than claiming
an uninterrupted clean pass.

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

## Abrupt process crashes

`test/live/crash-recovery.test.ts` is a separate opt-in SIGKILL test using a
real chat model and an isolated runtime home. Provide `NIGHTCREW_LIVE_CONFIG`
with a registered chat-model definition under `qwen`, stop the regular daemon,
and run with `NIGHTCREW_ALLOW_INFERENCE=1`. Always restore the regular daemon
when the test ends. The fixture injects away presence to isolate crash behavior;
it does not validate presence detection or launchd supervision.

It kills the service process during streamed generation, while a linked compactor
is running, and after a local receiver accepts the second message of a multipart
report but withholds its acknowledgement. It restarts from the same home and
checks preserved message identity, one final answer, reuse of the compactor run,
one committed checkpoint, and recall of the synthetic source facts. It also
checks that the crashed service leaves no llama.cpp or delivery-hook process alive.
The local receiver records accepted messages; it never contacts Discord.

Generation and compaction resume automatically. An uncertain external delivery
must instead remain unknown and require review: restart or retry must not resend
it. This does not promise exactly-once delivery or automatic completion of an
ambiguous batch. The receiver log, saved run files and `crash-recovery.json` remain
under the printed private test home for inspection.

The process guard uses a dedicated pipe whose EOF detects owner loss, including
SIGKILL, and terminates the guarded process group. Its unit tests include a child
that ignores SIGTERM and preservation of ordinary stdin/stdout/exit behavior.
This covers process crashes, not power loss, filesystem failure, or network-service
idempotency guarantees.

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
