import path from "node:path";
import { z } from "zod";
import { id } from "./common.js";
const validators = new Map<string, z.ZodType>();
export function toolValidator(parameters: ToolDefinition["parameters"]) {
  const key = JSON.stringify(parameters);
  let validator = validators.get(key);
  if (!validator) {
    validator = z.fromJSONSchema(parameters);
    if (validators.size >= 256)
      validators.delete(validators.keys().next().value!);
  } else validators.delete(key);
  validators.set(key, validator);
  return validator;
}
export const executableSchema = z.strictObject({
  executablePath: z.string().max(4096).refine(path.isAbsolute, "Executable path must be absolute"),
  argv: z.array(z.string().max(4000)).max(64).default([]),
  timeoutMs: z.number().int().min(100).max(600000).default(10000),
});
export const toolDefinitionSchema = executableSchema
  .extend({
    toolID: id,
    description: z.string().min(1).max(2000),
    parameters: z.record(z.string(), z.json()),

  })
  .superRefine((value, ctx) => {
    if (value.parameters.type !== "object")
      ctx.addIssue({
        code: "custom",
        message: "Tool parameters must be an object JSON Schema",
      });
    try {
      toolValidator(value.parameters);
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "Unsupported parameters schema",
      });
    }
  });
export type ToolDefinition = z.infer<typeof toolDefinitionSchema>;
