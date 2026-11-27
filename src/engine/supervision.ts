import { z } from "zod";
import { canonical } from "../utils/json.js";
import { terminal } from "../schemas/common.js";
import type { Message } from "../schemas/common.js";
import type { Run } from "../schemas/run.js";

export const loopPolicySchema = z.strictObject({
  consecutiveErrors: z.number().int().min(2).max(20).default(3),
  repeatedCalls: z.number().int().min(2).max(20).default(3),
});
export const validationRecordSchema = z.strictObject({
  turnID: z.string().uuid(),
  messageID: z.uuid(),
  status: z.enum(["passed", "failed", "error"]),
  reason: z.string().max(2000),
  at: z.iso.datetime(),
});
export const toolLoopSchema = z.strictObject({
  turnID: z.string().uuid(),
  afterMessageID: z.uuid(),
  reason: z.string().max(2000),
  finalizing: z.boolean().default(false),
});
export const outcomeSchema = z.strictObject({
  output: z.enum([
    "pending",
    "notConfigured",
    "notChecked",
    "passed",
    "failed",
    "error",
  ]),
  delivery: z.enum([
    "notConfigured",
    "pending",
    "succeeded",
    "failed",
    "unknown",
  ]),
  hooks: z.enum(["none", "pending", "succeeded", "failed", "unknown"]),
  needsAttention: z.boolean(),
  reasons: z.array(z.string()),
});
export function runOutcome(run: Run): z.infer<typeof outcomeSchema> {
  const records = run.validations.filter((v) => v.turnID === run.turnID);
  const validation = records.at(-1);
  const output =
    validation?.status ??
    (run.agent.finishSchema
      ? terminal(run.state)
        ? "notChecked"
        : "pending"
      : "notConfigured");
  // Older files may contain multiple invocations for one hook/event. Retain all
  // evidence, but report the latest recorded outcome without retry-chain metadata.
  const latestReceipts = new Map<string, Run["hookReceipts"][number]>();
  for (const receipt of run.hookReceipts)
    latestReceipts.set(
      JSON.stringify([receipt.eventID, receipt.hookID]),
      receipt,
    );
  const receipts = [...latestReceipts.values()].filter(
    (h) =>
      run.events.find((e) => e.eventID === h.eventID)?.turnID === run.turnID,
  );
  const aggregate = (list: typeof receipts) =>
    list.some((h) => h.status === "failed")
      ? ("failed" as const)
      : list.some((h) => h.status === "unknown")
        ? ("unknown" as const)
        : list.some((h) => ["pending", "started"].includes(h.status))
          ? ("pending" as const)
          : ("succeeded" as const);
  const deliveries = receipts.filter((h) => h.purpose === "delivery");
  const delivery = deliveries.length
    ? aggregate(deliveries)
    : run.deliveryExpected
      ? "pending"
      : "notConfigured";
  const hooks = receipts.length ? aggregate(receipts) : "none";
  const reasons: string[] = [];
  if (["invalidOutput", "failed", "timedOut", "cancelled"].includes(run.state))
    reasons.push(run.error?.message ?? `Execution ${run.state}`);
  if (["failed", "error"].includes(output)) reasons.push(validation!.reason);
  if (
    run.pauseReason === "runtimeError" ||
    run.pauseReason === "contextFull" ||
    run.pauseReason === "storageLimit"
  )
    reasons.push(run.error?.message ?? run.pauseReason);
  if (
    run.toolLoop &&
    run.toolLoop.turnID === run.turnID &&
    run.toolLoop.finalizing
  )
    reasons.push(run.toolLoop.reason);
  if (["failed", "unknown"].includes(hooks))
    reasons.push(
      `Lifecycle hooks ${hooks}; inspect receipts before retrying side effects`,
    );
  const needsAttention = reasons.length > 0;
  return {
    output,
    delivery,
    hooks,
    needsAttention,
    reasons,
  };
}
export function loopProblem(
  messages: Message[],
  policy: z.infer<typeof loopPolicySchema>,
): string | null {
  const calls = new Map(
    messages.flatMap((m) => m.toolCalls.map((c) => [c.callID, c] as const)),
  );
  const latest = [...messages].reverse().find((m) => m.role === "tool");
  const latestCall = calls.get(latest?.toolCallID ?? "");
  const signature = (call: { name: string; arguments: string }) => {
    let args = call.arguments;
    try {
      args = canonical(JSON.parse(args));
    } catch {}
    return call.name + ":" + args;
  };
  const latestKey = latestCall ? signature(latestCall) : null;
  let errors = 0;
  const repeats = new Map<string, number>();
  for (const m of [...messages].reverse()) {
    if (m.role !== "tool") continue;
    const call = calls.get(m.toolCallID ?? "");
    let output: any;
    try {
      output = JSON.parse(m.content);
    } catch {
      output = null;
    }
    if (output?.ok === false) errors++;
    else errors = -10000;
    if (
      m === latest &&
      (output?.error?.code === "tool_budget_exhausted" ||
        /budget exhausted/i.test(output?.error?.message ?? ""))
    )
      return "A tool reported an exhausted budget; stop requesting it and finish or choose a different capability.";
    if (errors >= policy.consecutiveErrors)
      return `${policy.consecutiveErrors} consecutive tool errors; correct the request using the returned schema or change approach.`;
    if (call) {
      const key = signature(call);
      const count = (repeats.get(key) ?? 0) + 1;
      repeats.set(key, count);
      if (key === latestKey && count >= policy.repeatedCalls)
        return `Repeated unchanged ${call.name} calls; reuse the evidence or change the query.`;
    }
  }
  return null;
}
export class DuplicateJSONKeyError extends Error {}
// JSON.parse accepts duplicate keys by silently overwriting them. Check each
// object's decoded keys before exposing the parsed value to completion/validation.
export function parseOutputJSON(text: string): unknown {
  const result: unknown = JSON.parse(text);
  const stack: Array<{
    object: boolean;
    keys: Set<string>;
    key: string;
    expectKey: boolean;
    index: number;
    path: string;
  }> = [];
  for (const match of text.matchAll(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\],:]/g)) {
    const token = match[0];
    const parent = stack.at(-1);
    if (token === "{" || token === "[") {
      const path = parent
        ? parent.path +
          (parent.object ? "." + parent.key : "[" + parent.index + "]")
        : "$";
      stack.push({
        object: token === "{",
        keys: new Set(),
        key: "",
        expectKey: token === "{",
        index: 0,
        path,
      });
    } else if (token === "}" || token === "]") stack.pop();
    else if (token === "," && parent) {
      parent.expectKey = parent.object;
      if (!parent.object) parent.index++;
    } else if (token === ":" && parent) parent.expectKey = false;
    else if (token.startsWith('"') && parent?.object && parent.expectKey) {
      const key: string = JSON.parse(token);
      if (parent.keys.has(key))
        throw new DuplicateJSONKeyError(
          `Duplicate JSON key ${JSON.stringify(key)} at ${parent.path}. You repeated fields inside one object. If these represent multiple array items, submit separate objects separated by commas; each object must contain each field only once. Preserve all intended items.`,
        );
      parent.keys.add(key);
      parent.key = key;
    }
  }
  return result;
}
