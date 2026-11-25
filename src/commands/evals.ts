import { z } from "zod";
import {
  evalRunResultSchema,
  evalRunSchema,
  evalSampleSchema,
  evalSuiteSchema,
} from "../engine/evals/format.js";
import { runEval } from "../engine/evals/runner.js";
import { remainingTimeout } from "../engine/execution/process.js";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import { id } from "../schemas/common.js";
import { chatAcceptanceSchema } from "../schemas/run.js";
import { createOperations } from "../utils/commands/definition.js";
import type { Define } from "../utils/commands/registry.js";
import { type ManagementInput } from "../utils/commands/resources.js";

const control: typeof import("../server/daemon.js").control = async (...args) =>
  (await import("../server/daemon.js")).control(...args);
export const operationInputs = {
  "evals release": z.strictObject({}),
  "evals sample": evalSampleSchema,
};
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, resourceID, dryRun = false } = input;
  const [] = command.split(" ");
  const name = resourceID === undefined ? undefined : id.parse(resourceID);
  const raw = input.request ?? {};
  if (command === "evals release") {
    const chat = service.chat(name ?? fail("missing_id"));
    if (
      !chat.evalOptions ||
      !["completed", "failed", "cancelled", "timedOut"].includes(chat.state)
    )
      fail("eval_not_terminal");
    if (!dryRun) service.chats.delete(chat.requestID);
    return { changed: !dryRun };
  }
  if (command === "evals sample") {
    const request = operationInputs["evals sample"].parse(raw);
    if (dryRun) return { changed: false, request };
    return service.submitChat(request, { sampling: request.sampling });
  }
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "evals release": defineOperation(
    "evals release",
    "Release a terminal eval sample after saving its result",
    z.object({ changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "evals sample": defineOperation(
    "evals sample",
    "Generate one eval turn; return all tool calls without executing any",
    z.union([
      chatAcceptanceSchema,
      z.object({
        changed: z.literal(false),
        request: operationInputs["evals sample"],
      }),
    ]),
    true,
    "none",
    false,
    "daemon",
  ),
};
export function registerLocal(define: Define) {
  define(
    "evals validate",
    "Validate an eval suite without inference",
    "static",
    "none",
    false,
    z.object({
      suiteID: z.string(),
      cases: z.number(),
      valid: z.literal(true),
    }),
    async (c) => {
      const suite = evalSuiteSchema.parse(c.request);
      return { suiteID: suite.suiteID, cases: suite.cases.length, valid: true };
    },
    { request: evalSuiteSchema },
  );
  define(
    "evals run",
    "Run a suite with mocked tools and save a create-only result bundle",
    "local",
    "none",
    true,
    evalRunResultSchema,
    async (c) =>
      runEval(
        c.request,
        (command, request = {}, resourceID) =>
          control(
            c.home,
            { command, request, ...(resourceID ? { resourceID } : {}) },
            remainingTimeout(90000),
          ),
        c.dryRun,
      ),
    { request: evalRunSchema },
  );
}
