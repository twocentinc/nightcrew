import { z } from "zod";
import {
  schedulerSchema,
} from "../engine/scheduling/policy.js";
import { loggingSchema } from "../server/logging.js";
import { agentSchema, triggerSchema } from "./agent.js";
import { timestamp } from "./common.js";
import { modelSchema } from "./model.js";

import { hookSchema } from "./hook.js";
export const configSchema = z.strictObject({
  scheduler: schedulerSchema.default(() => schedulerSchema.parse({})),
  revision: z.number().int().positive().max(2147483647),
  httpEnabled: z.boolean().default(true),
  host: z.enum(["127.0.0.1", "::1"]),
  port: z.number().int().min(1024).max(65535),
  interactionCooldownMs: z.number().int().min(0).max(3600000),
  logging: loggingSchema.default({
    level: "warn",
    maxBytes: 1048576,
    files: 3,
  }),
  rootTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  models: z.array(modelSchema).max(32),
  hooks: z.array(hookSchema).max(16),
});
export const storeSchema = z.strictObject({
  version: z.literal(3),
  config: configSchema,
  agents: z.array(agentSchema).max(1000),
  triggers: z.array(triggerSchema).max(1000).default([]),
  cooldownUntil: timestamp.nullable(),
});
export type Config = z.infer<typeof configSchema>;
export type Store = z.infer<typeof storeSchema>;
export function validateConfig(store: Store) {
  const { config, agents } = store;
  if (
    config.scheduler.instantModelID &&
    !config.models.some(
      (m) => m.modelID === config.scheduler.instantModelID && m.kind === "chat",
    )
  )
    throw new Error("Instant model must reference a configured chat model");
  const triggers = store.triggers ?? [];
  if (
    new Set(triggers.map((t) => t.triggerID)).size !== triggers.length ||
    triggers.some((t) => !agents.some((a) => a.agentID === t.agentID))
  )
    throw new Error("Invalid trigger agent reference or duplicate identity");
  for (const xs of [
    config.hooks.map((h) => h.hookID),
    config.models.map((x) => x.modelID),
    agents.map((x) => x.agentID),
  ])
    if (new Set(xs).size !== xs.length) throw new Error("Duplicate identity");
  for (const model of config.models) {
    if (
      model.compactionThresholdTokens &&
      (model.kind !== "chat" ||
        model.compactionThresholdTokens > model.contextTokens)
    )
      throw Error(
        "Compaction threshold must fit the chat model context capacity",
      );
  }
  for (const a of agents) {
    if (
      a.finishSchema &&
      config.models.find((m) => m.modelID === a.modelID)?.kind !== "chat"
    )
      throw Error("Finish schemas require a chat model");
    if (a.finishSchema && a.toolIDs.includes("finish"))
      throw Error("finish is runtime-owned; omit it from toolIDs");
    if (a.compaction?.handler.type === "agent") {
      const handler = a.compaction.handler;
      const compactor = agents.find((c) => c.agentID === handler.agentID);
      if (
        !compactor ||
        compactor.agentID === a.agentID ||
        compactor.mode !== "single-turn" ||
        !config.models.some(
          (m) => m.modelID === compactor.modelID && m.kind === "chat",
        )
      )
        throw Error("Compactor must reference another single-turn chat agent");
    }
    const model = config.models.find((x) => x.modelID === a.modelID);
    if (!model) throw new Error("Invalid agent model");
    if (a.mode === "single-turn" && (a.toolIDs.length || a.skillIDs.length))
      throw new Error("Single-turn agents do not use tools or skills");
    if (model.kind === "audio" && a.mode !== "single-turn")
      throw new Error("Audio agents must be single-turn");
    if (
      new Set(a.toolIDs).size !== a.toolIDs.length ||
      new Set(a.skillIDs).size !== a.skillIDs.length
    )
      throw new Error("Duplicate capability");
  }
}
export const publicConfigSchema = configSchema
  .omit({ rootTokenHash: true, models: true, hooks: true })
  .extend({
    models: z.array(
      modelSchema.omit({ weightsPath: true, projectorPath: true }),
    ),
    hooks: z.array(hookSchema.omit({ executablePath: true })),
  });

export const adminConfig = configSchema.omit({ rootTokenHash: true });
export const configMutation = z.object({
  changed: z.boolean(),
  restartRequired: z.boolean(),
  config: adminConfig,
  agentID: z.string().optional(),
});
