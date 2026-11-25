import { z } from "zod";
import { runErrorSchema } from "./common.js";

export const pauseReasonSchema = z.enum([
  "presence",
  "cooldown",
  "instant",
  "restart",
  "manualStop",
  "timeSlice",
  "scheduler",
  "compaction",
  "context_full",
  "runtime_error",
  "storage_limit",
]);
export const storageLimitSchema = z.strictObject({
  resource: z.enum([
    "bytes",
    "messages",
    "events",
    "attempts",
    "hookReceipts",
    "compactions",
    "pendingInputs",
    "triggerHistory",
    "validations",
    "capabilityRefreshes",
  ]),
  used: z.number().int().nonnegative(),
  maximum: z.number().int().positive(),
});
const error = runErrorSchema.unwrap();
export const executionSchema = z
  .discriminatedUnion("state", [
    z.strictObject({ state: z.literal("queued") }),
    z.strictObject({ state: z.literal("running") }),
    z.strictObject({
      state: z.literal("paused"),
      reason: pauseReasonSchema,
      resume: z.enum(["automatic", "manual"]),
      error: error.optional(),
      limit: storageLimitSchema.optional(),
    }),
    z.strictObject({ state: z.literal("completed") }),
    z.strictObject({ state: z.literal("failed"), error: error.optional() }),
    z.strictObject({ state: z.literal("cancelled"), error: error.optional() }),
    z.strictObject({ state: z.literal("timedOut"), error: error.optional() }),
  ])
  .superRefine((value, ctx) => {
    if (value.state !== "paused") return;
    if (
      ["manualStop", "context_full", "runtime_error", "storage_limit"].includes(
        value.reason,
      ) &&
      value.resume !== "manual"
    )
      ctx.addIssue({
        code: "custom",
        message: "This pause requires manual intervention",
      });
    if (value.reason === "storage_limit" && !value.limit)
      ctx.addIssue({
        code: "custom",
        message: "Storage pause requires the exhausted limit",
      });
    if (value.reason !== "storage_limit" && value.limit)
      ctx.addIssue({
        code: "custom",
        message: "Limit evidence is only valid for a storage pause",
      });
  });
export type ExecutionState = z.infer<typeof executionSchema>;
// Execution steps mutate their working state before one atomic durable transition.
// Only the discriminated execution record is persisted or exposed publicly.
export type WorkingExecution = {
  state:
    | "queued"
    | "running"
    | "paused"
    | "completed"
    | "failed"
    | "cancelled"
    | "timedOut";
  held: boolean;
  pauseReason: z.infer<typeof pauseReasonSchema> | null;
  error: z.infer<typeof runErrorSchema>;
  storageLimit?: z.infer<typeof storageLimitSchema>;
};
export function executionRecord(run: WorkingExecution): ExecutionState {
  if (run.state === "queued" && run.held)
    return { state: "paused", reason: "manualStop", resume: "manual" };
  if (run.state === "paused")
    return executionSchema.parse({
      state: "paused",
      reason: run.pauseReason ?? (run.held ? "manualStop" : "scheduler"),
      resume: run.held ? "manual" : "automatic",
      ...(run.error ? { error: run.error } : {}),
      ...(run.pauseReason === "storage_limit" && run.storageLimit
        ? { limit: run.storageLimit }
        : {}),
    });
  if (["failed", "cancelled", "timedOut"].includes(run.state))
    return executionSchema.parse({
      state: run.state,
      ...(run.error ? { error: run.error } : {}),
    });
  return executionSchema.parse({ state: run.state });
}
export function workingExecution(execution: ExecutionState): WorkingExecution {
  return {
    state: execution.state,
    held: execution.state === "paused" && execution.resume === "manual",
    pauseReason: execution.state === "paused" ? execution.reason : null,
    error: "error" in execution ? (execution.error ?? null) : null,
    ...(execution.state === "paused" && execution.limit
      ? { storageLimit: execution.limit }
      : {}),
  };
}
