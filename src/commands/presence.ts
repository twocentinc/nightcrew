import { statusSchema } from "../engine/contracts.js";
import { checkpoint } from "../engine/execution.js";
import { samplePresence } from "../engine/runtime.js";
import type { Define } from "./registry.js";

export const operationInputs = {};

export const operations = {};

export function registerLocal(define: Define) {
  define(
    "presence sample",
    "Sample this desktop's presence without requiring a daemon or runtime home",
    "local",
    "none",
    false,
    statusSchema.shape.presence,
    async () => {
      try {
        return await samplePresence();
      } catch {
        checkpoint();
        return {
          state: "present",
          reason: "samplingFailure",
          samplingHealthy: false,
          observedAt: new Date().toISOString(),
          diagnostic: "Presence sampling failed",
        };
      }
    },
  );
}
