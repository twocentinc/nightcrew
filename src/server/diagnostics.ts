import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  loadRegistry,
  validateRegistry,
} from "../engine/capabilities/registry.js";
import { checkpoint, remainingTimeout } from "../engine/execution/process.js";
import { LlamaRuntime, samplePresence } from "../engine/models/runtime.js";
import { normalizeError } from "../engine/protocol.js";
import { executionSlots } from "../engine/scheduling/policy.js";
import { storeSchema, validateConfig, type Store } from "../schemas/config.js";
import { readJSON } from "../storage/files.js";

const capability = z.strictObject({
  adapterSupported: z.boolean(),
  modelVerified: z.literal(false),
});
export const capabilitiesSchema = z.strictObject({
  models: z.array(
    z.strictObject({
      modelID: z.string(),
      kind: z.enum(["chat", "audio"]),
      available: z.boolean(),
      slotIDs: z.array(z.string()),
      tools: capability,
      audio: capability,
      streaming: capability,
      interruption: z.literal("unverified"),
      limitations: z.array(z.string()),
    }),
  ),
  tools: z.array(
    z.strictObject({
      toolID: z.string(),
      executablePath: z.string(),
      sandboxed: z.literal(false),
    }),
  ),
  limitations: z.array(z.string()),
});
export const doctorSchema = z.strictObject({
  healthy: z.boolean(),
  live: z.boolean(),
  serviceReady: z.boolean().nullable(),
  checks: z.array(
    z.strictObject({
      id: z.string(),
      status: z.enum(["pass", "warn", "fail"]),
      message: z.string(),
      details: z.record(z.string(), z.json()),
    }),
  ),
  capabilities: capabilitiesSchema,
  agents: z.array(
    z.strictObject({
      agentID: z.string(),
      eligibility: z.enum(["eligible", "blocked", "unverified"]),
      blockers: z.array(z.string()),
    }),
  ),
});
type Capabilities = z.infer<typeof capabilitiesSchema>;
export async function capabilities(
  home: string,
  store?: Store,
): Promise<Capabilities> {
  const state =
    store ??
    (await readJSON(
      path.join(home, "config.json"),
      storeSchema,
      8 * 1024 * 1024,
    ));
  validateConfig(state);
  const registry = await loadRegistry(home);
  validateRegistry(state.agents, registry.skills, registry.tools);
  const models = [];
  for (const model of state.config.models) {
    checkpoint();
    let available = true;
    for (const file of [model.weightsPath, model.projectorPath].filter(
      (x): x is string => x !== null,
    )) {
      try {
        if (!path.isAbsolute(file) || !(await lstat(file)).isFile())
          available = false;
        else await access(file, constants.R_OK);
      } catch {
        available = false;
      }
    }
    const chat = model.kind === "chat";
    models.push({
      modelID: model.modelID,
      kind: model.kind,
      available,
      slotIDs: executionSlots(state.config)
        .filter((s) => s.modelID === model.modelID)
        .map((s) => s.slotID)
        .sort(),
      tools: { adapterSupported: chat, modelVerified: false as const },
      audio: { adapterSupported: !chat, modelVerified: false as const },
      streaming: { adapterSupported: chat, modelVerified: false as const },
      interruption: "unverified" as const,
      limitations: [
        "Model-specific behavior and interruption have not been verified by this diagnostic.",
      ],
    });
  }
  return {
    models: models.sort((a, b) => a.modelID.localeCompare(b.modelID)),
    tools: [...registry.tools.values()]
      .map((t) => ({
        toolID: t.toolID,
        executablePath: t.executablePath,
        sandboxed: false as const,
      }))
      .sort((a, b) => a.toolID.localeCompare(b.toolID)),
    limitations: [
      "Capability support describes the implemented adapter, not a successful model inference test.",
      "Tools run with the local user permissions; Nightcrew does not enforce read-only behavior or provide an OS sandbox.",
    ],
  };
}
export async function doctor(
  home: string,
  live: boolean,
  probe: (timeout: number) => Promise<unknown>,
): Promise<z.infer<typeof doctorSchema>> {
  const checks: z.infer<typeof doctorSchema>["checks"] = [];
  let state: Store | undefined;
  let report: Capabilities = { models: [], tools: [], limitations: [] };
  let status: Record<string, unknown> | undefined;
  let serviceReady: boolean | null = null;
  const check = async (
    id: string,
    fn: () => Promise<{
      status: "pass" | "warn" | "fail";
      message: string;
      details?: Record<string, z.infer<ReturnType<typeof z.json>>>;
    }>,
  ) => {
    checkpoint();
    try {
      const item = await fn();
      checks.push({ id, ...item, details: item.details ?? {} });
    } catch (e) {
      checkpoint();
      const error = normalizeError(e);
      checks.push({
        id,
        status: "fail",
        message: error.message,
        details: { code: error.code },
      });
    }
  };
  await check("home", async () => {
    const s = await lstat(home);
    const valid =
      s.isDirectory() &&
      !s.isSymbolicLink() &&
      (s.mode & 0o077) === 0 &&
      s.uid === process.getuid?.();
    return {
      status: valid ? "pass" : "fail",
      message: valid
        ? "Private runtime home is valid"
        : "Runtime home ownership or permissions are unsafe",
    };
  });
  await check("configuration", async () => {
    state = await readJSON(
      path.join(home, "config.json"),
      storeSchema,
      8 * 1024 * 1024,
    );
    validateConfig(state);
    return { status: "pass", message: "Configuration is valid" };
  });
  if (state) {
    const configured = state;
    await check("registry", async () => {
      report = await capabilities(home, configured);
      return {
        status: "pass",
        message: "Agent, skill and tool references are valid",
      };
    });
    await check("llamaServer", async () => {
      await new LlamaRuntime(() => configured.config).initialize();
      return {
        status: "pass",
        message:
          "Compatible llama-server is available on PATH; no models loaded",
      };
    });
    if (!report.models.length)
      checks.push({
        id: "models",
        status: "warn",
        message: "No models configured",
        details: {},
      });
    for (const model of report.models)
      checks.push({
        id: "model." + model.modelID,
        status: model.available ? "pass" : "fail",
        message: model.available
          ? "Configured model files are readable"
          : "Configured model files are unavailable",
        details: { modelID: model.modelID, inferenceVerified: false },
      });
    await check("externalTools", async () => {
      const { tools } = await loadRegistry(home);
      const unavailable = [];
      for (const tool of tools.values())
        try {
          await access(tool.executablePath!, constants.X_OK);
        } catch {
          unavailable.push(tool.toolID);
        }
      return {
        status: unavailable.length ? "fail" : "pass",
        message: unavailable.length
          ? "External tool executables unavailable"
          : "External tool executable checks passed",
        details: { unavailable },
      };
    });
  }
  await check("presence", async () => {
    const presence = await samplePresence();
    return {
      status: presence.samplingHealthy ? "pass" : "fail",
      message: presence.samplingHealthy
        ? "Desktop presence sampling is healthy"
        : "Desktop presence sampling failed",
      details: { state: presence.state, reason: presence.reason },
    };
  });
  if (live) {
    serviceReady = false;
    await check("daemon", async () => {
      status = z
        .object({
          pid: z.number().int().positive(),
          presence: z.object({
            state: z.enum(["away", "present"]),
            samplingHealthy: z.boolean(),
            observedAt: z.string(),
          }),
          cooldownUntil: z.string().nullable(),
          queue: z.array(z.unknown()),
        })
        .passthrough()
        .parse(await probe(remainingTimeout(5000)));
      const pid = Number(
        await readFile(path.join(home, "daemon.lock"), "utf8"),
      );
      const valid = pid === status.pid;
      const presence = status.presence as {
        observedAt: string;
        samplingHealthy: boolean;
      };
      serviceReady =
        valid && Date.now() - Date.parse(presence.observedAt) < 15000;
      return {
        status: serviceReady ? "pass" : "fail",
        message: serviceReady
          ? "Daemon responds with a current, PID-matched status"
          : "Daemon status is stale or does not match its lock",
        details: { pidMatched: valid },
      };
    });
  }
  const agents = (state?.agents ?? []).map((agent) => {
    const blockers: string[] = [];
    const model = report.models.find((m) => m.modelID === agent.modelID);
    if (!model?.available) blockers.push("model_files_unavailable");
    if (!agent.enabled) blockers.push("agent_disabled_for_automatic_dispatch");
    if (!live) blockers.push("daemon_not_probed");
    else if (!serviceReady) blockers.push("daemon_unavailable");
    if (status) {
      const p = status.presence as { state: string; samplingHealthy: boolean };
      if (!p.samplingHealthy) blockers.push("presence_unhealthy");
      else if (p.state !== "away") blockers.push("desktop_present");
      if (Date.parse(String(status.cooldownUntil ?? "")) > Date.now())
        blockers.push("interaction_cooldown");
      if ((status.queue as unknown[]).length) blockers.push("queued_work");
    }
    return {
      agentID: agent.agentID,
      eligibility: !live
        ? ("unverified" as const)
        : blockers.length
          ? ("blocked" as const)
          : ("eligible" as const),
      blockers,
    };
  });
  return {
    healthy: checks.every((c) => c.status !== "fail"),
    live,
    serviceReady,
    checks,
    capabilities: report,
    agents,
  };
}
