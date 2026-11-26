import { z } from "zod";
import { canonical } from "../../utils/json.js";
import type { ToolDefinition } from "../../schemas/tool.js";
import type { EvalDefinition } from "./format.js";
export function overrideTool(
  definition: ToolDefinition | undefined,
  name: string,
  args: string,
  evaluation: EvalDefinition,
) {
  const error = (message: string) => ({
    ok: false,
    error: { code: "eval_tool_mismatch", outcome: "not_started", message },
  });
  if (!definition) return error("Tool is not available to this agent");
  let input: unknown;
  try {
    input = JSON.parse(args);
    z.fromJSONSchema(definition.parameters).parse(input);
  } catch {
    return error("Tool arguments do not match its schema");
  }
  const rules = evaluation.tools.filter((t) => t.toolID === name);
  const rule =
    rules.find(
      (t) => t.input !== undefined && canonical(t.input) === canonical(input),
    ) ?? rules.find((t) => t.input === undefined);
  return rule ? rule.output : error("No eval response matches this tool input");
}
