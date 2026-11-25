import { doctor, doctorSchema } from "../server/diagnostics.js";
import type { Define } from "./registry.js";

const control: typeof import("../server/daemon.js").control = async (...args) =>
  (await import("../server/daemon.js")).control(...args);

export const operationInputs = {};

export const operations = {};

export function registerLocal(define: Define) {
  define(
    "doctor",
    "Check configuration, executables, presence and optional live daemon readiness",
    "local",
    "none",
    false,
    doctorSchema,
    (c) =>
      doctor(c.home, !!c.values.live, async (timeout) => {
        const result = (await control(
          c.home,
          { command: "status" },
          timeout,
        )) as { pid: number; runtime: object };
        return { pid: result.pid, ...result.runtime };
      }),
    { options: ["live"] },
  );
}
