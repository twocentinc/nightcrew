import { z } from "zod";
import type { Message } from "../schemas/common.js";
import type { Run } from "../schemas/run.js";

export const outputValidationSchema = z.strictObject({
  validator: z.discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("json-schema"),
      schema: z.record(z.string(), z.json()).superRefine((schema, ctx) => {
        try {
          z.fromJSONSchema(schema);
        } catch {
          ctx.addIssue({
            code: "custom",
            message: "Unsupported output JSON Schema",
          });
        }
      }),
    }),
    z.strictObject({
      type: z.literal("hook"),
      executablePath: z
        .string()
        .max(4096)
        .regex(/^\/[^\r\n]*$/),
      argv: z.array(z.string().max(4000)).max(64).default([]),
      timeoutMs: z.number().int().min(100).max(60000).default(10000),
    }),
  ]),
});
export const loopPolicySchema = z.strictObject({
  consecutiveErrors: z.number().int().min(2).max(20).default(3),
  repeatedCalls: z.number().int().min(2).max(20).default(3),
});
export const validationRecordSchema = z.strictObject({
  segment: z.number().int().nonnegative(),
  messageID: z.uuid(),
  status: z.enum(["passed", "failed", "error"]),
  reason: z.string().max(2000),
  at: z.iso.datetime(),
});
export const recoverySchema = z.strictObject({
  segment: z.number().int().nonnegative(),
  afterMessageID: z.uuid(),
  reason: z.string().max(2000),
  finalizing: z.boolean().default(false),
});
export function effectiveReceipts(run: Run) {
  const superseded = new Set(
    run.hookReceipts.map((r) => r.retryOfReceiptID).filter(Boolean),
  );
  return run.hookReceipts.filter((r) => !superseded.has(r.receiptID));
}

export const outcomeSchema = z.strictObject({
  execution: z.enum([
    "queued",
    "running",
    "paused",
    "completed",
    "failed",
    "cancelled",
    "timedOut",
  ]),
  output: z.enum(["pending", "notConfigured", "passed", "failed", "error"]),
  task: z.enum(["pending", "unverified", "validated", "needsAttention"]),
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
  nextAction: z.string().nullable(),
});
export function runOutcome(run: Run): z.infer<typeof outcomeSchema> {
  const terminal = ["completed", "failed", "cancelled", "timedOut"].includes(
    run.state,
  );
  const records = run.validations.filter((v) => v.segment === run.segment);
  const validation = records.at(-1);
  const output =
    validation?.status ??
    (run.agent.outputValidation ? "pending" : "notConfigured");
  const receipts = effectiveReceipts(run).filter(
    (h) =>
      run.events.find((e) => e.eventID === h.eventID)?.segment === run.segment,
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
  if (["failed", "timedOut", "cancelled"].includes(run.state))
    reasons.push(run.error?.message ?? `Execution ${run.state}`);
  if (["failed", "error"].includes(output)) reasons.push(validation!.reason);
  if (
    run.pauseReason === "runtime_error" ||
    run.pauseReason === "context_full" ||
    run.pauseReason === "storage_limit"
  )
    reasons.push(run.error?.message ?? run.pauseReason);
  if (run.recovery?.segment === run.segment && run.recovery.finalizing)
    reasons.push(run.recovery.reason);
  if (["failed", "unknown"].includes(hooks))
    reasons.push(
      `Lifecycle hooks ${hooks}; inspect receipts before retrying side effects`,
    );
  const needsAttention = reasons.length > 0;
  return {
    execution: run.state,
    output,
    task: needsAttention
      ? "needsAttention"
      : !terminal
        ? "pending"
        : output === "passed"
          ? "validated"
          : "unverified",
    delivery,
    hooks,
    needsAttention,
    reasons,
    nextAction: needsAttention
      ? "Inspect runs get and runs transcript; correct the reported issue before submitting a new turn. Do not blindly retry delivery."
      : null,
  };
}
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => JSON.stringify(k) + ":" + stable(v))
      .join(",")}}`;
  return JSON.stringify(value);
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
      args = stable(JSON.parse(args));
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
      let args = call.arguments;
      try {
        args = stable(JSON.parse(args));
      } catch {}
      const key = call.name + ":" + args;
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

export async function validateOutput(
  run: Run,
  message: Message,
  home: string,
  signal: AbortSignal,
): Promise<z.infer<typeof validationRecordSchema>> {
  const config = run.agent.outputValidation!;
  let status: "passed" | "failed" | "error" = "passed",
    reason =
      "Configured output validation passed; factual accuracy is not implied.";
  try {
    if (config.validator.type === "json-schema") {
      let value: unknown;
      try {
        value = parseOutputJSON(message.content);
      } catch (error) {
        if (error instanceof DuplicateJSONKeyError) throw error;
        throw Error("Output is not valid JSON");
      }
      const result = z.fromJSONSchema(config.validator.schema).safeParse(value);
      if (!result.success)
        throw Error(
          result.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        );
    } else {
      const { executeExternalTool } =
        await import("./capabilities/registry.js");
      const result = await executeExternalTool(
        {
          toolID: "output_validator",
          description: "Validate final output",
          parameters: {
            type: "object",
            properties: {
              runID: { type: "string" },
              segment: { type: "integer" },
              text: { type: "string" },
            },
            required: ["runID", "segment", "text"],
            additionalProperties: false,
          },
          ...config.validator,
        },
        { runID: run.runID, segment: run.segment, text: message.content },
        signal,
        { home, agentID: run.agent.agentID, runID: run.runID },
      );
      const verdict = z
        .strictObject({ valid: z.boolean(), reason: z.string().max(2000) })
        .parse(result);
      if (!verdict.valid) {
        status = "failed";
        reason = verdict.reason || "Validator rejected output";
      }
    }
  } catch (error) {
    signal.throwIfAborted();
    status = config.validator.type === "hook" ? "error" : "failed";
    reason =
      error instanceof Error
        ? error.message.slice(0, 2000)
        : "Output validation failed";
  }
  return {
    segment: run.segment,
    messageID: message.messageID,
    status,
    reason: reason.slice(0, 2000),
    at: new Date().toISOString(),
  };
}
