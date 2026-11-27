import { randomUUID } from "node:crypto";
import type { Storage } from "../../storage/store.js";
import { fail } from "../protocol.js";
import type { Dispatch } from "../scheduling/dispatch.js";
import { executionSlots } from "../scheduling/policy.js";
import type { Runtime, Result } from "./types.js";

export type ModelTestInput = {
  prompt: string;
  maxOutputTokens: number;
  sampling: import("../../schemas/agent.js").Agent["sampling"];
  thinking: boolean;
  timeoutMs: number;
};
interface Dependencies {
  storage: Storage;
  runtime: Runtime;
  dispatch: Pick<Dispatch, "withIdleRuntime" | "clearResidentModel">;
}
/** Explicit model operations share scheduler admission, never agent/run persistence. */
export class ModelOperations {
  constructor(private readonly ports: Dependencies) {}
  test(modelID: string, input: ModelTestInput, dryRun: boolean) {
    return this.ports.dispatch.withIdleRuntime(async (signal) => {
      const config = this.ports.storage.store.config;
      const model =
        config.models.find((m) => m.modelID === modelID) ??
        fail("model_not_found", 404);
      if (model.kind !== "chat") fail("model_test_requires_chat");
      const slots = executionSlots(config).filter((s) => s.modelID === modelID);
      const slot =
        slots.find((s) => !s.instant) ??
        slots[0] ??
        fail("model_slot_unavailable");
      if (dryRun)
        return {
          modelID,
          changed: false,
          elapsedMs: 0,
          result: null as Result | null,
        };
      const start = performance.now();
      try {
        const result = await this.ports.runtime.generate(
          {
            modelID,
            slotID: slot.slotID,
            contextID: "model-test-" + randomUUID(),
            persistContext: false,
            messages: [
              {
                messageID: randomUUID(),
                role: "user",
                content: input.prompt,
                attachments: [],
                toolCalls: [],
                toolCallID: null,
              },
            ],
            tools: [],
            maxOutputTokens: input.maxOutputTokens,
            sampling: input.sampling,
            thinking: input.thinking,
          },
          AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]),
        );
        return {
          modelID,
          changed: true,
          elapsedMs: Math.round(performance.now() - start),
          result,
        };
      } finally {
        this.ports.dispatch.clearResidentModel();
      }
    });
  }
  unload(modelID: string | undefined, all: boolean, dryRun: boolean) {
    if ((modelID !== undefined) === all) fail("choose_model_or_all");
    return this.ports.dispatch.withIdleRuntime(async () => {
      const config = this.ports.storage.store.config;
      if (
        modelID !== undefined &&
        !config.models.some((m) => m.modelID === modelID)
      )
        fail("model_not_found", 404);
      const modelIDs = all ? config.models.map((m) => m.modelID) : [modelID!];
      const resident = this.ports.runtime
        .status()
        .filter((m) => m.state !== "unloaded");
      const targets = resident.filter((m) => modelIDs.includes(m.modelID));
      // Current runtime owns one server; never close an unrelated resident model.
      if (!dryRun && (all || targets.length)) {
        if (resident.some((m) => !modelIDs.includes(m.modelID)))
          fail("runtime_busy", 409);
        await this.ports.runtime.close();
        this.ports.dispatch.clearResidentModel();
      }
      const unloadedModelIDs = dryRun ? [] : targets.map((m) => m.modelID);
      return {
        modelIDs,
        unloadedModelIDs,
        changed: unloadedModelIDs.length > 0,
      };
    });
  }
}
