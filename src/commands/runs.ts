import { z } from "zod";
import type { Service } from "../engine/service.js";
import { fail } from "../engine/service.js";
import {
  id,
  pageSchema,
  revision,
  userMessageSchema,
  uuid,
} from "../schemas/common.js";
import {
  acceptanceSchema,
  runDetailSchema,
  runState,
  runSummarySchema,
  searchMatchSchema,
  transcriptEntrySchema,
} from "../schemas/run.js";
import { exportRun, verifyRun } from "../storage/artifacts.js";
import { canonical } from "../utils/json.js";
import { createOperations } from "../utils/commands/definition.js";
import { type ManagementInput } from "../utils/commands/resources.js";

export const operationInputs = {
  "runs review": z.strictObject({
    expectedRevision: revision,
    status: z.enum(["open", "acknowledged", "resolved"]),
    note: z.string().trim().min(1).max(2000),
  }),
  "runs capabilities refresh": z.strictObject({ expectedRevision: revision }),
  "runs resume": z.strictObject({ expectedRevision: revision }),
  "runs retry": z.strictObject({
    expectedRevision: revision,
    messageID: uuid,
    note: z.string().trim().min(1).max(2000),
  }),
  "runs hooks retry": z.strictObject({
    expectedRevision: revision,
    receiptIndex: z.number().int().nonnegative(),
    requestID: uuid,
    note: z.string().trim().min(1).max(2000),
    acceptUnknown: z.boolean().default(false),
    hookPath: z.string().max(4096).optional(),
  }),
  "runs annotate": z.strictObject({
    messageID: uuid,
    content: z.string().trim().min(1).max(4000),
  }),
  "runs reply": z.strictObject({ message: userMessageSchema }),
  "runs pause": z.strictObject({ expectedRevision: revision }),
  "runs list": pageSchema.extend({
    agentID: id.optional(),
    state: runState.optional(),
  }),
  "runs transcript": pageSchema
    .extend({
      afterSequence: z.number().int().nonnegative().optional(),
      recent: z.boolean().optional(),
    })
    .refine(
      (v) =>
        !(v.cursor && (v.afterSequence !== undefined || v.recent)) &&
        !(v.recent && v.afterSequence !== undefined),
      "Cannot combine cursor, recent and afterSequence",
    ),
  "runs search": pageSchema.extend({
    agentID: id.optional(),
    state: runState.optional(),
  }),
  "runs export": z.strictObject({ destination: z.string().min(1).max(4096) }),
  "runs verify": z.strictObject({
    bundle: z.string().min(1).max(4096).optional(),
  }),
};
const requestSchemas: Record<string, z.ZodType> = operationInputs;
export async function handle(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, resourceID, dryRun = false } = input;
  const [resource, action] = command.split(" ");
  const name =
    resourceID === undefined || command === "runs search"
      ? undefined
      : id.parse(resourceID);
  const raw = input.request ?? {};
  if (command === "runs capabilities refresh")
    return service.refreshRunCapabilities(
      name ?? fail("missing_id"),
      operationInputs[command].parse(raw).expectedRevision,
      dryRun,
    );
  if (command === "runs review")
    return service.reviewRun(
      name ?? fail("missing_id"),
      operationInputs[command].parse(raw),
      dryRun,
    );
  if (command === "runs retry")
    return service.retryRun(
      name ?? fail("missing_id"),
      operationInputs[command].parse(raw),
      dryRun,
    );
  if (command === "runs hooks retry")
    return service.retryHook(
      name ?? fail("missing_id"),
      operationInputs[command].parse(raw),
      dryRun,
    );
  if (command === "runs annotate")
    return service.annotateRun(
      name ?? fail("missing_id"),
      operationInputs[command].parse(raw),
      dryRun,
    );
  if (command === "runs pause")
    return service.pauseRun(
      name ?? fail("missing_id"),
      operationInputs[command].parse(raw).expectedRevision,
      dryRun,
    );
  if (command === "runs resume")
    return service.queueControl(
      name ?? fail("missing_id"),
      "release",
      operationInputs[command].parse(raw).expectedRevision,
      dryRun,
    );
  if (resource === "runs") {
    const { userMessageSchema } = await import("../schemas/common.js");
    if (action === "run" || action === "reply") {
      const { message } = z
        .strictObject({ message: userMessageSchema })
        .parse(raw);
      return service.submit(
        name ?? fail("missing_id"),
        message,
        action === "reply",
        dryRun,
      );
    }
    if (action === "cancel")
      return service.cancelRun(name ?? fail("missing_id"), dryRun);
    if (action === "transcript") {
      const input = operationInputs["runs transcript"].parse(raw);
      if (input.afterSequence !== undefined || input.recent) {
        const entries = service.transcript(
          await service.run(name ?? fail("missing_id")),
        );
        const items = input.recent
          ? entries.slice(-input.limit)
          : entries
              .filter((e) => e.sequence > input.afterSequence!)
              .slice(0, input.limit);
        return { items, nextCursor: null };
      }
    }
    if (action === "list" || action === "transcript" || action === "search") {
      const input = requestSchemas[command]!.parse(raw) as {
        limit: number;
        cursor?: string;
        agentID?: string;
        state?: string;
      };
      const query =
        action === "search"
          ? z.string().min(1).max(1000).parse(resourceID)
          : undefined;
      const key =
        "cli:" +
        command +
        ":" +
        canonical([
          resourceID ?? null,
          input.agentID ?? null,
          input.state ?? null,
        ]);
      return service.page(key, input, async () => {
        if (action === "list")
          return service.listRuns(input.agentID, input.state) as Promise<
            unknown[]
          >;
        if (action === "search")
          return service.search(query!, input.agentID, input.state);
        return service.transcript(
          await service.run(name ?? fail("missing_id")),
        );
      });
    }
    if (action === "export") {
      const input = requestSchemas[command]!.parse(raw) as {
        destination: string;
      };
      return exportRun(
        service,
        name ?? fail("missing_id"),
        input.destination,
        dryRun,
      );
    }
    if (action === "verify") {
      const input = requestSchemas[command]!.parse(raw) as {
        bundle?: string;
      };
      return verifyRun(service, name ?? fail("missing_id"), input.bundle);
    }
    if (action === "get")
      return {
        run: service.detail(await service.run(name ?? fail("missing_id"))),
      };
  }
  return fail("unknown_command");
}
const defineOperation = createOperations(operationInputs, handle);
export const operations = {
  "runs capabilities refresh": defineOperation(
    "runs capabilities refresh",
    "Explicitly refresh tools and skills of a terminal run without inference or history loss",
    z.object({
      runID: z.string(),
      revision: z.number().int(),
      changed: z.boolean(),
      toolIDs: z.array(z.string()),
      skillIDs: z.array(z.string()),
    }),
    true,
    "required",
    false,
    "daemon",
  ),
  "runs review": defineOperation(
    "runs review",
    "Acknowledge, resolve or reopen a run review with a durable note",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "runs resume": defineOperation(
    "runs resume",
    "Explicitly release a paused or held run",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "runs retry": defineOperation(
    "runs retry",
    "Retry the last input in the same transcript with a new message UUID",
    acceptanceSchema,
    true,
    "required",
    true,
    "daemon",
  ),
  "runs hooks retry": defineOperation(
    "runs hooks retry",
    "Explicitly retry a failed hook with a durable attempt and request UUID",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    true,
    "daemon",
  ),
  "runs pause": defineOperation(
    "runs pause",
    "Pause active work or hold queued work with a revision check",
    z.object({ run: runDetailSchema, changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
  "runs list": defineOperation(
    "runs list",
    "List durable run summaries",
    z.object({
      items: z.array(runSummarySchema),
      nextCursor: z.string().nullable(),
    }),
    false,
    "none",
    false,
    "management",
    ["limit", "cursor", "agent", "state"],
  ),
  "runs get": defineOperation(
    "runs get",
    "Inspect a durable run",
    z.object({ run: runDetailSchema }),
    false,
    "required",
    false,
    "management",
  ),
  "runs transcript": defineOperation(
    "runs transcript",
    "Read committed run evidence",
    z.object({
      items: z.array(transcriptEntrySchema),
      nextCursor: z.string().nullable(),
    }),
    false,
    "required",
    false,
    "management",
    ["limit", "cursor"],
  ),
  "runs search": defineOperation(
    "runs search",
    "Search saved messages, attachments and results with bounded excerpts",
    z.object({
      items: z.array(searchMatchSchema),
      nextCursor: z.string().nullable(),
    }),
    false,
    "required",
    false,
    "daemon",
    ["limit", "cursor", "agent", "state"],
  ),
  "runs export": defineOperation(
    "runs export",
    "Export a committed run snapshot and checksum manifest to a new directory",
    z.object({
      runID: z.string(),
      destination: z.string(),
      changed: z.boolean(),
      revision: z.number(),
      lastEventSequence: z.number(),
    }),
    true,
    "required",
    false,
    "management",
  ),
  "runs verify": defineOperation(
    "runs verify",
    "Validate saved run integrity or an exported bundle without modifying it",
    z.object({
      runID: z.string(),
      valid: z.boolean(),
      checks: z.array(z.string()),
      errors: z.array(z.string()),
      revision: z.number().nullable(),
      lastEventSequence: z.number().nullable(),
    }),
    false,
    "required",
    false,
    "management",
  ),
  "runs annotate": defineOperation(
    "runs annotate",
    "Append a passive notification without invoking the agent",
    z.object({
      messageID: z.string(),
      revision: z.number(),
      replayed: z.boolean(),
    }),
    true,
    "required",
    false,
    "daemon",
  ),
  "runs reply": defineOperation(
    "runs reply",
    "Submit a continuation to a completed or cancelled run",
    acceptanceSchema,
    true,
    "required",
    false,
    "daemon",
  ),
  "runs cancel": defineOperation(
    "runs cancel",
    "Cancel managed work",
    z.object({ runID: z.string(), status: z.string(), changed: z.boolean() }),
    true,
    "required",
    false,
    "daemon",
  ),
};
