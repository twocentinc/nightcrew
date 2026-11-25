import { runtimeConfig } from "../../fixtures.ts";
import { readFile } from "node:fs/promises";
import { startServer } from "../../../dist/server/http.js";
import { LlamaRuntime } from "../../../dist/engine/models/runtime.js";
const home = process.argv[2];
const config = JSON.parse(
  (await readFile(home + "/config.json", "utf8")).toString(),
).config;
let app: any;
const runtime = new LlamaRuntime(
  () => runtimeConfig(app?.service.storage.store.config ?? config),
  home,
);
app = await startServer({
  home,
  port: 0,
  runtime,
  quiet: true,
  presence: async () => ({
    state: "away",
    samplingHealthy: true,
    observedAt: new Date().toISOString(),
    reason: "isolated crash fixture",
    diagnostic: null,
  }),
});
process.send!({
  port: (app.server.address() as import("node:net").AddressInfo).port,
});
let pid: any;
const timer = setInterval(() => {
  if (runtime["server"]["child"]?.pid && runtime["server"]["child"].pid !== pid) {
    pid = runtime["server"]["child"].pid;
    process.send!({ runtimePID: pid });
  }
}, 25);
process.on("message", async (m) => {
  if (m === "close") {
    clearInterval(timer);
    await app.close();
    process.exit(0);
  }
});
