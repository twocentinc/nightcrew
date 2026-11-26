import { snapshotGrader } from "./results.js";
import { agentSchema, type Agent } from "../../schemas/agent.js";
import { validateConfig, type Store } from "../../schemas/config.js";
import {
  evalSchema,
  normalizeEval,
  authorMessage,
  type EvalDefinition,
} from "./format.js";
import { canonical } from "../../utils/json.js";
import { fail } from "../protocol.js";
export function editTools(
  definition: EvalDefinition,
  action: "set" | "delete",
  input: { tool: string; input?: Record<string, unknown>; output?: unknown },
) {
  const key = canonical([input.tool, input.input ?? null]);
  const index = definition.tools.findIndex(
    (t) => canonical([t.tool, t.input ?? null]) === key,
  );
  if (action === "delete") {
    if (index < 0) fail("eval_tool_not_found", 404);
    definition.tools.splice(index, 1);
  } else {
    const rule = {
      tool: input.tool,
      ...(input.input === undefined ? {} : { input: input.input }),
      output: input.output,
    };
    const next = evalSchema.parse({
      ...definition,
      tools: [...definition.tools.filter((_, i) => i !== index), rule],
    });
    definition.tools = next.tools;
  }
  return normalizeEval(definition);
}
export function editTranscript(
  definition: EvalDefinition,
  action: string,
  input: { messages?: unknown[]; message?: unknown; messageID?: string },
) {
  if (action === "clear") definition.messages = [];
  else if (action === "set")
    definition.messages = (input.messages ?? []).map((m) =>
      authorMessage.parse(m),
    );
  else if (action === "append")
    definition.messages.push(
      ...(input.messages ?? []).map((m) => authorMessage.parse(m)),
    );
  else {
    const index = definition.messages.findIndex(
      (m) => m.messageID === input.messageID,
    );
    if (index < 0) fail("eval_message_not_found", 404);
    const prior = definition.messages[index]!;
    if (action === "update")
      definition.messages[index] = authorMessage.parse({
        ...authorMessage.parse(input.message),
        messageID: prior.messageID,
      });
    else {
      const calls = new Set(prior.toolCalls.map((c) => c.callID));
      definition.messages = definition.messages.filter(
        (m, i) => i !== index && (!m.toolCallID || !calls.has(m.toolCallID)),
      );
    }
  }
  return normalizeEval(definition);
}

/** Apply only explicit eval overrides, then use the ordinary agent/config validators. */
export function evaluationAgent(
  agent: Agent,
  definition: EvalDefinition,
  store: Store,
) {
  const value = agentSchema.parse({
    ...agent,
    ...definition.overrides,
  });
  validateConfig({
    ...store,
    agents: store.agents.map((a) => (a.agentID === value.agentID ? value : a)),
  });
  return value;
}

export async function prepareEvaluation(
  definition: EvalDefinition,
  revision: number,
) {
  const normalized = normalizeEval(definition);
  if (!normalized.messages.some((m) => m.role === "user"))
    fail("eval_transcript_requires_user");
  return {
    definition: normalized,
    revision,
    initialMessages: 0,
    grader: normalized.grader?.exec
      ? await snapshotGrader(normalized.grader.exec)
      : undefined,
    grade: { status: "pending" as const },
  };
}
