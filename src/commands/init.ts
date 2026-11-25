import { z } from "zod";
import { configSchema } from "../engine/contracts.js";
import { initializeHome } from "../storage/store.js";
import type { Define } from "./registry.js";

export const operationInputs = {
  init: configSchema
    .omit({ rootTokenHash: true, revision: true })
    .partial()
    .extend({
      host: configSchema.shape.host.default("127.0.0.1"),
      port: configSchema.shape.port.default(6970),
      interactionCooldownMs:
        configSchema.shape.interactionCooldownMs.default(300000),
      models: configSchema.shape.models.default([]),
      slots: configSchema.shape.slots.default([]),
      hooks: configSchema.shape.hooks.default([]),
    }),
};

const adminConfig = configSchema.omit({ rootTokenHash: true });

export const operations = {};

export function registerLocal(define: Define) {
  define(
    "init",
    "Initialize a private runtime home without overwriting it",
    "local",
    "none",
    true,
    z.union([
      z.object({
        changed: z.literal(true),
        home: z.string(),
        token: z.string(),
      }),
      z.object({
        changed: z.literal(false),
        home: z.string(),
        settings: adminConfig.omit({ revision: true }),
      }),
    ]),
    async (c) => {
      const settings = c.request as Parameters<typeof initializeHome>[1];
      return c.dryRun
        ? { changed: false, home: c.home, settings }
        : {
            changed: true,
            home: c.home,
            ...(await initializeHome(c.home, settings)),
          };
    },
  );
}
