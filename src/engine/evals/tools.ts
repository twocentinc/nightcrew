import { z } from "zod";
import type { ChatInput, Message } from "../../schemas/common.js";
import { canonical } from "../../utils/json.js";
import type { EvalSuite } from "./format.js";

export function dispatchMock(
  call: Message["toolCalls"][number],
  c: EvalSuite["cases"][number],
  tools: ChatInput["tools"],
  callIDs: Set<string>,
  counts: Record<string, number>,
) {
  if (callIDs.has(call.callID))
    throw Error("fixture_mismatch: duplicate callID");
  callIDs.add(call.callID);
  const tool = (c.mocks.length ? tools : []).find((t) => t.name === call.name);
  if (!tool) throw Error("fixture_mismatch: unavailable tool " + call.name);
  let args;
  try {
    args = JSON.parse(call.arguments);
    z.fromJSONSchema(tool.parameters).parse(args);
  } catch {
    throw Error("fixture_mismatch: invalid arguments");
  }
  const mock = c.mocks.find(
    (m) => m.tool === call.name && canonical(m.arguments) === canonical(args),
  );
  if (!mock)
    throw Error("fixture_mismatch: unmatched arguments for " + call.name);
  const index = counts[mock.mockID] ?? 0;
  const response =
    mock.responses[index] ??
    (mock.afterExhausted === "repeatLast" ? mock.responses.at(-1) : undefined);
  if (!response) throw Error("fixture_mismatch: exhausted " + mock.mockID);
  counts[mock.mockID] = index + 1;

  return response;
}
