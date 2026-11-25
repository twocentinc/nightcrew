import { z } from "zod";
import {
  PROTOCOL_VERSION,
  SCHEMA_VERSION,
  packageVersion,
} from "../engine/protocol.js";
import type { Define } from "./registry.js";

export const operationInputs = {};

export const operations = {};

export function registerLocal(define: Define) {
  define(
    "version",
    "Report package, protocol and schema versions",
    "static",
    "none",
    false,
    z.object({
      version: z.string(),
      protocolVersion: z.number(),
      schemaVersion: z.number(),
    }),
    async () => ({
      version: packageVersion,
      protocolVersion: PROTOCOL_VERSION,
      schemaVersion: SCHEMA_VERSION,
    }),
  );
}
