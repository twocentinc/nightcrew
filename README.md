# Nightcrew

Nightcrew is a local agent orchestrator that waits until you're away to load
models for background work. When you return, it pauses those runs and unloads
their models as soon as they stop generating, freeing RAM for your work.

Runs keep their transcripts and resume when you're away again. Explicit
interactive requests and model tests can still run while you're present. See
[presence and memory](https://oss.twocents.com/docs/nightcrew/models/#when-model-ram-is-released)
for scheduling and unloading behavior.

Use the JSON CLI or optional HTTP API to configure agents, schedule work, and
read their transcripts and results.

- [Documentation](https://oss.twocents.com/docs/nightcrew/)
- [Installation and first run](https://oss.twocents.com/docs/nightcrew/getting-started/)
- [Set up llama-server and Qwen3.5](https://oss.twocents.com/docs/nightcrew/llama-cpp/)
- [Resource reference](https://oss.twocents.com/docs/nightcrew/resources/)
- [Command Map](https://oss.twocents.com/docs/nightcrew/command-map/)
- [Files and formats](https://oss.twocents.com/docs/nightcrew/files/)
- [Examples](https://oss.twocents.com/docs/nightcrew/examples/)
- [Compatibility and upgrades](https://oss.twocents.com/docs/nightcrew/compatibility/)

## Build from source

Use Node 22.12 or newer. Inference requires a compatible `llama-server` and
model weights you supply. macOS supports unattended operation with desktop
presence detection.

```sh
npm ci
npm run build
node dist/cli.js help
```

Follow the [getting started guide](https://oss.twocents.com/docs/nightcrew/getting-started/)
to initialize a runtime home, configure a model, and run an agent. The
[example walkthroughs](https://oss.twocents.com/docs/nightcrew/examples/) explain
the runnable agents included with Nightcrew.

## Development

Current contract: Nightcrew **0.55.0**, protocol **1**, schema **54**.

Run `npm run lint`, `npm test`, and `npm run test:package`. Real-model tests
require explicit opt-in. See the
[validation guide](https://oss.twocents.com/docs/nightcrew/contributing/).
Read [AGENTS.md](AGENTS.md) for repository policy and the
[specification](https://oss.twocents.com/docs/nightcrew/specification/)
for expected behavior.
