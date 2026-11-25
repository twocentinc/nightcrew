import { z } from "zod";
import { NightcrewError, SCHEMA_VERSION } from "../engine/protocol.js";
import type { Define } from "../utils/commands/registry.js";
import { exportSchemas } from "../utils/commands/registry.js";

export const operationInputs = {};

export const operations = {};

export function registerLocal(define: Define) {
  define(
    "schema get",
    "Read a generated request or result schema",
    "static",
    "required",
    false,
    z.object({
      name: z.string(),
      schemaVersion: z.number(),
      schema: z.record(z.string(), z.json()),
    }),
    async (c) => {
      const schemas = exportSchemas();
      let name = c.resourceID!;
      if (
        !name.endsWith(".request") &&
        !name.endsWith(".result") &&
        !name.startsWith("envelope.")
      )
        name += ".request";
      const schema = schemas[name];
      if (!schema)
        throw new NightcrewError(
          "resource.schemaNotFound",
          "Schema not found",
          7,
        );
      return { name, schemaVersion: SCHEMA_VERSION, schema };
    },
  );
}
