import { createHash } from "node:crypto";

export const canonical = (x: unknown): string => {
  if (Array.isArray(x)) return "[" + x.map(canonical).join(",") + "]";
  if (x && typeof x === "object")
    return (
      "{" +
      Object.entries(x)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(x);
};

export const fingerprint = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
