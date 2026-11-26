# Granite transcription

A singleTurn, manually invoked audio agent using the existing transcription
adapter. No recordings, transcripts or model weights are bundled.

Register a model with `kind: "audio"`, the local Granite GGUF `weightsPath`, its
matching `projectorPath`. Set scheduler context capacity to 8192 for the tested
setup. Use absolute regular-file paths; resolve asset symlinks first. Edit the
example `modelID` to match your configuration. Slots are allocated automatically.
This background agent obeys desktop-away and cooldown requirements.

```sh
nightcrew agents create --request agent.json
```

The audio endpoint transcribes the WAV attachment directly. The latest user
message content, when nonempty, is passed as its transcription prompt (for
example, vocabulary hints). It does not consume
the agent's text system prompt or use thinking. The example therefore has an
empty system prompt and no skills or tools. Output limits and temperature are
sent to the transcription endpoint. Results are plain text without speaker
labels. Automatic dispatch is disabled; manual invocation still works.

Prepare a short 16 kHz mono PCM WAV with your existing audio tooling. For example,
if ffmpeg is installed:

```sh
ffmpeg -i input.mp3 -t 30 -ac 1 -ar 16000 -c:a pcm_s16le clip.wav
```

Generate the ordinary submission request with a fresh UUID and invoke the agent:

```sh
node -e 'const fs=require("node:fs"),{randomUUID}=require("node:crypto");process.stdout.write(JSON.stringify({message:{messageID:randomUUID(),content:"",attachments:[{name:"clip.wav",mediaType:"audio/wav",dataBase64:fs.readFileSync("clip.wav").toString("base64")}]}}));' | nightcrew agents run transcribe-audio --request -
```

Use `nightcrew runs get <runID>` or `nightcrew runs transcript <runID>` for the
result. Audio attachments are persisted with the run, so use recordings you
intend to retain in your private Nightcrew home. Long recordings should be
prepared as chunks of up to 30 seconds with approximately two seconds of overlap;
this example does not automatically chunk or merge them. Do not count repeated
words in overlapping clips as independent speech or compare undeduplicated
chunk text as an accuracy score.
