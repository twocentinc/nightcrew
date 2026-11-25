import {
  agentDraftSchema,
  configSchema,
  messageSchema,
} from "../dist/engine/contracts.js";
import type { CompactionRequest } from "../dist/engine/compactionFormat.js";

// Tests author input objects; normalize defaults exactly as runtime admission does.
export const settings = configSchema
  .omit({ revision: true, rootTokenHash: true })
  .extend({
    interactionCooldownMs:
      configSchema.shape.interactionCooldownMs.default(300000),
  });
export const agentDraft = agentDraftSchema;
export function compactionFixture(input: {
  previousSummary: string | null;
  messages: Array<{ content: string }>;
}): CompactionRequest {
  return {
    version: 1,
    runID: "fixture",
    requestID: "fixture",
    targetTokens: 128,
    instructions: "",
    ...input,
    messages: input.messages.map((m, index) =>
      messageSchema.parse({
        messageID: "00000000-0000-4000-8000-" + String(index).padStart(12, "0"),
        role: "user",
        attachments: [],
        toolCalls: [],
        toolCallID: null,
        ...m,
      }),
    ),
  };
}

export function runtimeConfig(input: Record<string, any>) {
  return configSchema.parse({
    revision: 1,
    rootTokenHash: "0".repeat(64),
    host: "127.0.0.1",
    port: 6970,
    interactionCooldownMs: 0,
    slots: [],
    hooks: [],
    ...input,
    models: (input.models ?? []).map((model: Record<string, unknown>) => ({
      weightsPath: "/unused",
      projectorPath: null,
      idleUnloadMs: 0,
      ...model,
    })),
  });
}
