# Validation and release checks

This is the current validation guide. Test implementations are authoritative;
results apply only to the exact revision, models, settings, and environment tested.
Historical reports are retained under `docs/history/` and are not current release
acceptance evidence or setup instructions.

## Checks without real inference

Run from the checkout:

```sh
npm ci
npm run build
npm run lint
npm test
npm run contracts:check
npm run test:package
```

- Build before `lint` in a fresh checkout: test types import generated `dist/` declarations. `lint` checks source, test, and example TypeScript.
- `npm test` uses mocked runtime behavior and temporary homes. The package-installation test is skipped here and run separately by `test:package`.
- Contract checks compare discovery and schemas with the frozen schema-53 snapshots. Do not run `contracts:update` for a documentation edit or internal refactor.
- Package checks pack/install the CLI and verify public exports and example entrypoints. They do not establish model quality.
- `nightcrew status --doctor` checks installation readiness without loading models. Inspect `healthy` and each check; a successfully executed diagnostic can report an unhealthy installation.

## Real-model tests: explicit opt-in

- Live tests are excluded from `npm test` and require explicit authorization to run inference.
- Use existing model weights and a private settings file. Build first. Stop the regular Nightcrew daemon and any competing model servers, then run **one fixture at a time**.
- Restore the regular daemon after success or failure. Do not run all inference fixtures concurrently against the same machine's memory/model resources.
- The test-owned temporary homes and evidence are separate from the regular installation. Reports and transcripts can contain private data; do not commit them.
- Set `NIGHTCREW_ALLOW_INFERENCE=1` and `NIGHTCREW_LIVE_CONFIG` to the absolute settings path. Without the opt-in, live tests skip; skipped tests are not passes.
- `npm run test:live` discovers the live suite. For actual inference, use the individual commands below so fixtures run sequentially.

### Model behavior

Source: `test/live/models.test.ts`.

- Required settings: `qwen`, a chat-model definition accepted by `models create`'s inner `model` schema.
- Optional settings: `granite`, an audio-model definition; `audioFile`, an absolute WAV path when testing audio; `expectedAudioText`, a transcription substring to check.
- The fixture checks thinking, persistent restart, compaction, and optional audio using an isolated home. It sets its test chat/audio context capacities to 8192 tokens.
- It supplies test presence and does not establish real desktop-away detection.

```sh
npm run build
NIGHTCREW_ALLOW_INFERENCE=1 \
NIGHTCREW_LIVE_CONFIG=/absolute/path/to/private-settings.json \
node --experimental-strip-types --test test/live/models.test.ts
```

### Controlled unattended cycle

Source: `test/live/acceptance.test.ts`.

- Required settings: `instant` (chat model), `qwen` (background chat model), `granite` (audio model), and `audioFile` (a short WAV saying “hello world”). The models must fit the machine and support the fixture's context/output settings.
- This fixture uses real desktop presence; the desktop must already be away.
- It exercises an interval trigger, instant preemption, a five-second test cooldown, background resumption, a graceful service restart during generation, audio transcription, Qwen KV restoration after model switching, linked-agent compaction, synthetic fact recall, and local report export.
- KV restoration is checked at the runtime save/restore boundary; recall alone is not proof of cache restoration.
- The temporary home retains `acceptance.json`, run files, local reports, and snapshots. `NIGHTCREW_LIVE_OUTPUT` can name a file where the home path is written.

```sh
NIGHTCREW_ALLOW_INFERENCE=1 \
NIGHTCREW_LIVE_CONFIG=/absolute/path/to/private-settings.json \
node --experimental-strip-types --test test/live/acceptance.test.ts
```

`NIGHTCREW_LIVE_RESUME` may point to a previously printed acceptance home after
the priority/restart checkpoint. This resumes at audio/model-switching work and
renews only that test home's temporary token. Retain the original failure and
combined evidence; report this as a resumed cycle, not an uninterrupted pass.

A controlled cycle is not an overnight soak, an abrupt process crash, or proof
of external messaging integration behavior.

### Abrupt crashes

Source: `test/live/crash-recovery.test.ts`.

- Required setting: `qwen`, a chat-model definition. The fixture injects away presence, so it does not test presence detection or LaunchAgent supervision.
- It kills the service during streamed generation, linked compaction, and an ambiguous local HTTP hook delivery, then restarts from the same private home.
- It checks message identity, final-answer/checkpoint duplication, compactor reuse, synthetic fact recall, and termination of owned model/hook descendants.
- The local receiver accepts a delivery and withholds acknowledgement. The restarted run must retain an `unknown` receipt and must not send the delivery again. This is a generic HTTP hook test, not a multipart transport or Discord test.
- `crash-recovery.json`, receiver evidence, and run files remain under the printed test home. Uncertain delivery requires review; the fixture does not prove exactly-once delivery, power-loss durability, or network-service idempotency.

```sh
NIGHTCREW_ALLOW_INFERENCE=1 \
NIGHTCREW_LIVE_CONFIG=/absolute/path/to/private-settings.json \
node --experimental-strip-types --test test/live/crash-recovery.test.ts
```

## Evidence required for a release claim

- Record the Git commit/package version, model files, context/generation settings, platform, command, and retained evidence location.
- Distinguish mocked checks, real inference, graceful restart, SIGKILL, and external integration checks. One does not imply the others passed.
- Review actual compaction summaries and resumed answers against the source facts; schema validity and completion alone are insufficient.
- Record failures, skipped phases, fixture changes, and resumed phases. Do not convert a partial or resumed test into a clean overnight claim.
- Validate application-specific delivery with that integration's own tests. Nightcrew's local hook receiver does not verify a real external destination.
- Longer-duration storage growth, memory/concurrency behavior, preemption latency, and useful agent output require workload-specific observation. Historical experiments are not current measurements.
