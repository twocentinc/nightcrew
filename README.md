# Nightcrew

Nightcrew puts your computer's RAM and compute to work while you're away.
Background local models do not run while it detects you as present: it waits
for healthy desktop-away detection before loading models for queued work, and
pauses background inference when you return.

Models load on demand and unload when idle to release RAM. Unloading follows
the configured idle-unload delay and any remaining interactive cooldown, so
returning does not immediately free all model RAM. Explicit interactive requests
and model tests can run while you're present. See [presence and memory](https://oss.twocents.com/docs/nightcrew/models/#when-model-ram-is-released).

Configure each agent's model, tools, skills, and schedule through a JSON-first
CLI or the optional HTTP API, then review its transcripts and results.

Current release: **0.53.1**, protocol **1**, schema **53**.

- [Documentation](https://oss.twocents.com/docs/nightcrew/)
- [Installation and first run](https://oss.twocents.com/docs/nightcrew/getting-started/)
- [Command Map](https://oss.twocents.com/docs/nightcrew/command-map/)
- [Files and formats](https://oss.twocents.com/docs/nightcrew/files/)
- [Examples](https://oss.twocents.com/docs/nightcrew/examples/)
- [Compatibility and upgrades](https://oss.twocents.com/docs/nightcrew/compatibility/)

## Build from source

Use Node 22.12 or newer. Inference requires a compatible `llama-server` and
model weights you supply. macOS is the validated host for unattended operation.

```sh
npm ci
npm run build
node dist/cli.js help
```

Follow the [getting started guide](https://oss.twocents.com/docs/nightcrew/getting-started/)
to initialize a runtime home, configure a model, and run an agent. Runnable
JSON and TypeScript examples remain in `examples/`; their walkthroughs live in
the shared documentation.

## Development

Run `npm run lint`, `npm test`, and `npm run test:package`. Real-model tests are
opt-in; see the [validation guide](https://oss.twocents.com/docs/nightcrew/contributing/).
Read [AGENTS.md](AGENTS.md) for repository policy and the
[specification](https://oss.twocents.com/docs/nightcrew/specification/)
for architecture and behavior.
