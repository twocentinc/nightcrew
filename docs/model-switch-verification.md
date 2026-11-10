# Qwen and Granite switching verification

Verified November 9, 2026, with Nightcrew 0.7.0 and the installed llama.cpp
0.6.0 build. This was an explicit, isolated test using existing model weights;
the installed daemon was stopped for the test and restarted afterward. No
production conversations or recordings were used. the chat client integration was unchanged.

The runtime used Qwen 3.5 4B Q4_K_M with its projector and a 4096-token slot,
and Granite Speech 4.1 2B Q8_0 with its projector and an 8192-token slot. Granite
asset symlinks were resolved to their existing regular files before configuration.
A synthetic 16 kHz mono WAV said “Hello world. This is a Nightcrew transcription
test.” Snapshot storage used a private temporary home.

| Step                                                    | Observed result                                       | Elapsed |
| ------------------------------------------------------- | ----------------------------------------------------- | ------- |
| Load Qwen and complete                                  | `Hello world!`                                        | 3.452 s |
| Save Qwen, stop its router, load Granite and transcribe | `hello world this is a night crew transcription test` | 6.002 s |
| Stop Granite, reload Qwen, restore slot and complete    | `Hello world!`                                        | 6.279 s |

The save preceding eviction returned HTTP 200, `n_saved: 29`, and
`n_written: 53642868` (about 54 MB), with `save_ms: 103.857`. Restore returned
HTTP 200, `n_restored: 29`, and `n_read: 53642868`, with `restore_ms: 16.943`.
The first manual save also succeeded. The final shutdown saved the slot again.

Process samples at 250 ms intervals saw at most two llama-server processes:
one router and one model worker, with old PIDs disappearing before the next
pair. The runtime also waits for the old process group to exit before launching
the next router. Sampling alone cannot rule out an overlap shorter than its
interval; the sequential shutdown/start boundary supplies that guarantee.

The first attempt exposed a real compatibility issue: router slot POST requests
require `model` in their JSON body. A query parameter alone returned HTTP 400
“model name is missing from the request”. Save, restore and erase now include
the model in the body, and the fake-server regression test rejects its absence.

This verifies successful short-text snapshot restoration and synthetic speech
transcription on this installation. It does not measure long-context performance,
prove a prompt-processing speedup, or verify interrupted Granite transcription,
vision attachments, or compatibility across model/runtime upgrades. Model load
latency remains even when prompt-cache restoration is fast. No permanent logging
or inference-metrics feature was added for this verification.
