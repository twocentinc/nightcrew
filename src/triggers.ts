import { z } from "zod";

function field(text: string, min: number, max: number) {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    if (!/^(\*|\d+(-\d+)?)(\/\d+)?$/.test(part))
      throw Error("Invalid cron field");
    const [range, stride] = part.split("/");
    const step = stride === undefined ? 1 : Number(stride);
    const [start, end] =
      range === "*"
        ? [min, max]
        : range!.includes("-")
          ? range!.split("-").map(Number)
          : [Number(range), stride ? max : Number(range)];
    if (
      !Number.isSafeInteger(step) ||
      step < 1 ||
      start! < min ||
      end! > max ||
      start! > end!
    )
      throw Error("Invalid cron range or step");
    for (let n = start!; n <= end!; n += step) values.add(n);
  }
  return values;
}
export function parseCron(expression: string) {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) throw Error("Cron requires five fields");
  return {
    minute: field(parts[0]!, 0, 59),
    hour: field(parts[1]!, 0, 23),
    day: field(parts[2]!, 1, 31),
    month: field(parts[3]!, 1, 12),
    weekday: new Set([...field(parts[4]!, 0, 7)].map((v) => v % 7)),
    dayWildcard: parts[2]!.startsWith("*"),
    weekdayWildcard: parts[4]!.startsWith("*"),
  };
}
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
        parseCron(value.expression);
      } catch {
        ctx.addIssue({
          code: "custom",
          message: "Invalid five-field numeric cron expression",
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
  const cron = parseCron(schedule.expression);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: schedule.timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const start = Math.floor(after / 3600000) * 3600000;
  const parts = (at: number) =>
    Object.fromEntries(
      formatter.formatToParts(at).map((part) => [part.type, part.value]),
    );
  const eligible = (p: Record<string, string>) => {
    const dom = cron.day.has(Number(p.day)),
      dow = cron.weekday.has(weekdays.indexOf(p.weekday!));
    const day =
      cron.dayWildcard || cron.weekdayWildcard ? dom && dow : dom || dow;
    return (
      day && cron.month.has(Number(p.month)) && cron.hour.has(Number(p.hour))
    );
  };
  // Inspect both ends of each UTC hour to account for fractional offsets and DST changes.
  for (let h = 0; h < 5 * 366 * 24; h++) {
    if (h % 256 === 0) check();
    const hour = start + h * 3600000;
    const first = parts(hour),
      last = parts(hour + 59 * 60000);
    if (!eligible(first) && !eligible(last)) continue;
    const offsets = new Set([
      Number(first.minute),
      (Number(last.minute) - 59 + 60) % 60,
    ]);
    const candidates = new Set<number>();
    for (const offset of offsets)
      for (const minute of cron.minute)
        candidates.add((minute - offset + 60) % 60);
    for (const minute of [...candidates].sort((a, b) => a - b)) {
      const at = hour + minute * 60000;
      if (at <= after) continue;
      const p = parts(at);
      if (eligible(p) && cron.minute.has(Number(p.minute)))
        return new Date(at).toISOString();
    }
  }
  return null;
}
