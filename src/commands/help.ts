import { z } from "zod";
import type { Define } from "../utils/commands/registry.js";
import { help } from "../utils/commands/registry.js";

export const operationInputs = {};

export const operations = {};

const helpDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  scope: z.string(),
  operand: z.string(),
  mutates: z.boolean(),
  confirmation: z.boolean(),
  options: z.array(z.string()),
  requestSchema: z.string(),
  resultSchema: z.string(),
});
export function registerLocal(define: Define) {
  define(
    "help",
    "Discover commands and their contracts",
    "static",
    "scope",
    false,
    z.object({
      scope: z.string(),
      tree: z.record(z.string(), z.array(z.string())),
      definitions: z.array(helpDefinitionSchema).optional(),
      options: z.array(z.string()),
      schemaVersion: z.number(),
    }),
    async (c) => {
      const { commands, ...details } = help(
        c.helpScope ?? c.resourceID ?? "",
        !!c.values.advanced,
      );
      const tree: Record<string, string[]> = {};
      for (const command of commands) {
        const [root, ...words] = command.split(" ");
        tree[root!] ??= [];
        if (words.length) tree[root!]!.push(words.join(" "));
      }
      return { ...details, tree };
    },
  );
}
