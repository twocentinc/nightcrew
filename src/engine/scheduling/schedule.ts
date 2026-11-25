import { CronExpressionParser } from "cron-parser";
import { z } from "zod";

export const scheduleSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("manual") }),
  z.strictObject({
    type: z.literal("interval"),
    everyMs: z.number().int().min(60000).max(31536000000),
  }),
  z
    .strictObject({
      type: z.literal("cron"),
      expression: z.string().min(1).max(200),
      timezone: z.string().min(1).max(100),
    })
    .superRefine((value, ctx) => {
      try {
        CronExpressionParser.parse(value.expression);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Invalid cron expression",
          path: ["expression"],
        });
      }
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: value.timezone }).format(
          0,
        );
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Invalid timezone",
          path: ["timezone"],
        });
      }
    }),
]);
export function nextFireAt(
  schedule: z.infer<typeof scheduleSchema>,
  anchor: string,
  after = Date.now(),
  check: () => void = () => {},
): string | null {
  if (schedule.type === "manual") return null;
  if (schedule.type === "interval") {
    const start = Date.parse(anchor);
    return new Date(
      start +
        Math.max(1, Math.floor((after - start) / schedule.everyMs) + 1) *
          schedule.everyMs,
    ).toISOString();
  }
  check();
  const iterator = CronExpressionParser.parse(schedule.expression, {
    currentDate: after,
    tz: schedule.timezone,
  });
  const next = iterator.hasNext() ? iterator.next().toISOString() : null;
  check();
  return next;
}
