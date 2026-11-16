import { evalSampleSchema } from "./evals.js";
import { loggingSchema } from "./logging.js";
import { z } from "zod";
import {
  chatInputSchema,
  triggerDraftSchema,
  uuid,
  agentDraftSchema,
  agentSchema,
  configSchema,
  modelSchema,
  slotSchema,
  skillSchema,
  skillLoadInputSchema,
  userMessageSchema,
  pageSchema,
  id,
  runState,
} from "./contracts.js";
import { toolDefinitionSchema } from "./registry.js";
const revision = z.number().int().positive();
export const operationInputs = {
  status: z.strictObject({ details: z.boolean().default(false) }),
  "evals release": z.strictObject({}),
  "evals sample": evalSampleSchema,
  "runs review": z.strictObject({
    expectedRevision: revision,
    status: z.enum(["open", "acknowledged", "resolved"]),
    note: z.string().trim().min(1).max(2000),
  }),
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
  "agents run": z.strictObject({ message: userMessageSchema }),
  "runs reply": z.strictObject({ message: userMessageSchema }),
  "instant submit": chatInputSchema,
  "triggers create": z.strictObject({ trigger: triggerDraftSchema }),
  "triggers update": z.strictObject({
    expectedRevision: revision,
    changes: triggerDraftSchema
      .omit({ triggerID: true })
      .partial()
      .extend({
        enabled: z.boolean().optional(),
        queuePolicy: z.enum(["skip", "enqueue", "coalesce"]).optional(),
        message: userMessageSchema.omit({ messageID: true }).optional(),
      }),
  }),
  "triggers delete": z.strictObject({ expectedRevision: revision }),


  "triggers fire": z.strictObject({
    occurrenceID: uuid.optional(),
    message: userMessageSchema.omit({ messageID: true }).optional(),
  }),

  "runs pause": z.strictObject({ expectedRevision: revision }),


  "runs list": pageSchema.extend({
    agentID: id.optional(),
    state: runState.optional(),
  }),
  "runs transcript": pageSchema,
  "runs search": pageSchema.extend({
    agentID: id.optional(),
    state: runState.optional(),
  }),
  "runs export": z.strictObject({ destination: z.string().min(1).max(4096) }),
  "runs verify": z.strictObject({
    bundle: z.string().min(1).max(4096).optional(),
  }),
  init: configSchema
    .omit({ rootTokenHash: true, revision: true })
    .partial()
    .extend({
      host: configSchema.shape.host.default("127.0.0.1"),
      port: configSchema.shape.port.default(6970),
      interactionCooldownMs:
        configSchema.shape.interactionCooldownMs.default(300000),
      models: configSchema.shape.models.default([]),
      slots: configSchema.shape.slots.default([]),
      hooks: configSchema.shape.hooks.default([]),
    }),
  "config update": z.strictObject({
    expectedRevision: revision,
    changes: configSchema
      .omit({ rootTokenHash: true, revision: true })
      .partial()
      .extend({
        httpEnabled: configSchema.shape.httpEnabled.unwrap().optional(),
        logging: loggingSchema.optional(),
        scheduler: z.strictObject(Object.fromEntries(Object.entries(configSchema.shape.scheduler.unwrap().shape).map(([key, field]) => [key, field.unwrap().optional()]))).optional(),
      }),
  }),
  "agents create": z.strictObject({ agent: agentDraftSchema }),
  "agents update": z.strictObject({
    expectedRevision: revision,
    changes: agentSchema
      .omit({ agentID: true, revision: true, createdAt: true, updatedAt: true })
      .partial()
      .extend({
        outputValidation: agentSchema.shape.outputValidation
          .unwrap()
          .optional(),
        loopPolicy: agentSchema.shape.loopPolicy.unwrap().optional(),
        compaction: agentSchema.shape.compaction.unwrap().optional(),
        storageLimitMB: agentSchema.shape.storageLimitMB.unwrap().optional(),
        contextMode: z.enum(["fresh", "persistent"]).optional(),
        priority: z.number().int().min(-100).max(100).optional(),
        timeSliceMs: z.number().int().min(100).max(3600000).optional(),
        slotID: id.optional(),
        thinking: z.boolean().optional(),
        temperature: z.number().min(0).max(2).optional(),
        maxOutputTokens: z.number().int().min(1).max(32768).optional(),
      }),
  }),


  "agents delete": z.strictObject({ expectedRevision: revision }),
  "models create": z.strictObject({
    model: modelSchema,
    slots: z.array(slotSchema).max(32).default([]),
  }),
  "models update": z.strictObject({
    expectedRevision: revision,
    changes: modelSchema.omit({ modelID: true }).partial().extend({
      compactionThresholdTokens: modelSchema.shape.compactionThresholdTokens
        .unwrap()
        .optional(),
      priority: modelSchema.shape.priority.unwrap().optional(),
      slotSnapshots: modelSchema.shape.slotSnapshots.unwrap().optional(),
    }),
  }),
  "models delete": z.strictObject({ expectedRevision: revision }),



  "skills read": skillLoadInputSchema.extend({ runID: id.optional() }),
  "skills create": z.strictObject({ skill: skillSchema }),
  "skills update": z.strictObject({
    expectedHash: z.string(),
    skill: z.strictObject({
      ...skillSchema.shape,
      files: skillSchema.shape.files.unwrap().optional(),
    }),
  }),
  "skills delete": z.strictObject({ expectedHash: z.string() }),
  "tools create": z.strictObject({ tool: toolDefinitionSchema }),
  "tools update": z.strictObject({
    expectedHash: z.string(),
    tool: toolDefinitionSchema,
  }),
  "tools delete": z.strictObject({ expectedHash: z.string() }),
};

export const requestSchemas: Record<string, z.ZodType> = operationInputs;
