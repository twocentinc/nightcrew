# Real-model validation (prepared, not run)

The normal suite uses mock inference. test/live/models.test.mjs starts actual
llama.cpp workers and is intentionally excluded from npm test. It has not been
executed for the 0.14 changes.

Before running, stop competing model-serving daemons, verify llama-server is on
PATH, and make existing model files available. The suite does not download weights
or modify the installed Nightcrew home. It creates an isolated temporary home,
prints its location, and retains transcripts for inspection.

Provide a JSON file with qwen containing a normal Nightcrew chat-model definition.
Optionally provide granite (an audio-model definition), audioFile (absolute path
to a short WAV), and expectedAudioText (a phrase expected in the transcription).
Use distinct model IDs. Enable qwen.slotSnapshots.enabled to exercise persistent
KV restoration; otherwise restart coverage checks transcript reconstruction.

Only when ready to explicitly authorize real inference, run:

    npm run build
    NIGHTCREW_ALLOW_INFERENCE=1 NIGHTCREW_LIVE_CONFIG=/absolute/path/live-models.json npm run test:live

The suite checks thinking on, fallback to the thinking-off default, persistent
run identity and recall after restart, real token counting and summarizer-agent
compaction, and optional Granite transcription. It allows fifteen minutes.

Separate workload validation is still needed for preemption latency, model
residency fairness, KV restore speed, concurrent-slot memory use, script-summary
quality and prolonged storage growth. A passing suite establishes only its
assertions, not general summary quality or transcription accuracy.
