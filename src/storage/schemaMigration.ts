import { agentSchema } from "../schemas/agent.js";
/** Offline schema conversion. Runtime readers never call these converters. */
import { canonical } from "../utils/json.js";

function generation(value: any) {
  if (value.temperature !== undefined) {
    value.sampling = { ...value.sampling, temperature: value.temperature };
    delete value.temperature;
  }
  if (value.sampling?.parallelToolCalls !== undefined) {
    value.parallelToolCalls = value.sampling.parallelToolCalls;
    delete value.sampling.parallelToolCalls;
  }
}
function executable(value: any) {
  if (!value || typeof value !== "object") return;
  if (value.arguments !== undefined) {
    value.argv = value.arguments;
    delete value.arguments;
  }
  value.argv ??= [];
}
function agent(value: any) {
  generation(value);
  if (value.mode === "single-turn") value.mode = "singleTurn";
  if (value.mode === "agent-loop") value.mode = "agentLoop";
  const validator = value.outputValidation?.validator;
  if (validator?.type === "json-schema") {
    value.finishSchema = !value.finishSchema || canonical(value.finishSchema) === canonical(validator.schema)
      ? validator.schema
      : { type: "object", allOf: [value.finishSchema, validator.schema] };
  }
  delete value.finishValidator;
  delete value.outputValidation;
  if (value.compaction?.handler?.type === "script") {
    value.compaction.handler.type = "exec";
    executable(value.compaction.handler);
  }
}
export function upgradeDefinition(value: any) {
  const result = structuredClone(value);
  generation(result.overrides ?? {});
  for (const rule of result.tools ?? []) {
    if (rule.tool !== undefined) {
      rule.toolID = rule.tool;
      delete rule.tool;
    }
  }
  return result;
}
export function upgradeContract(value: any): any {
  if (Array.isArray(value)) return value.map(upgradeContract);
  if (!value || typeof value !== "object") return value;
  // Do not reinterpret model content, arbitrary tool output, or JSON Schema properties.
  if (typeof value.agentID === "string" && typeof value.systemPrompt === "string") {
    const result = structuredClone(value);
    agent(result);
    return agentSchema.parse(result);
  }
  if (typeof value.evalID === "string" && typeof value.agentID === "string")
    return upgradeDefinition(value);
  const result: any = { ...value };
  for (const [key, item] of Object.entries(value)) {
    if (["messages", "parameters", "finishSchema", "schema", "content", "arguments", "output"].includes(key)) continue;
    result[key] = upgradeContract(item);
  }
  if (typeof result.receiptID === "string" && typeof result.hookID === "string") {
    delete result.retryOfReceiptID;
    delete result.requestID;
    delete result.note;
  }
  if (typeof result.sourceAgentRevision === "number" && typeof result.turnID === "string") {
    delete result.previousToolIDs;
    delete result.previousSkillIDs;
    delete result.previousTools;
    delete result.previousSkills;
  }
  if (result.recovery !== undefined) {
    result.toolLoop = result.recovery;
    delete result.recovery;
  }
  const reasons: Record<string, string> = {
    context_full: "contextFull", runtime_error: "runtimeError", storage_limit: "storageLimit",
  };
  if (result.state === "paused" && reasons[result.reason]) result.reason = reasons[result.reason];
  if (result.type === "loopRecovery") result.type = "toolLoopUpdated";
  if (result.config) {
    executable(result.config.scheduler?.hook);
    for (const hook of result.config.hooks ?? []) executable(hook);
  }
  if (result.execution?.state === "failed" &&
      ["invalid_finish", "output_validation_failed"].includes(result.execution.error?.code))
    result.execution.state = "invalidOutput";
  return result;
}
