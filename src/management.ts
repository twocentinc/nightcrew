import { capabilities } from "./diagnostics.js";
import { operationInputs } from "./operationInputs.js";
import {
  canonicalSkill,
  loadSkillContent,
  writeSkillFolder,
} from "./skills.js";
import { nextFireAt } from "./triggers.js";
import { exportRun, verifyRun } from "./runArtifacts.js";
import { checkpoint } from "./execution.js";
import {
  mkdir,
  writeFile,
  rename,
  unlink,
  lstat,
  readFile,
} from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import {
  storeSchema,
  triggerDraftSchema,
  triggerSchema,
  agentDraftSchema,
  agentSchema,
  configSchema,
  modelSchema,
  slotSchema,
  skillSchema,
  id,
  now,
  terminal,
  validateConfig,
  type Store,
  type Run,
} from "./contracts.js";
import { Service, fail } from "./service.js";
import { atomicJSON, canonical, tokenHash } from "./storage.js";
import {
  toolDefinitionSchema,
  validateRegistry,
  builtinTools,
} from "./registry.js";
import { requestSchemas } from "./operationInputs.js";
export type ManagementInput = {
  command: string;
  resourceID?: string;
  request?: unknown;
  dryRun?: boolean;
  yes?: boolean;
};
export const fingerprint = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");
function exposeConfig(store: Store) {
  const { rootTokenHash, ...config } = store.config;
  return config;
}
async function verifyModels(store: Store) {
  for (const m of store.config.models)
    for (const f of [m.weightsPath, m.projectorPath].filter(
      (s): s is string => s !== null,
    )) {
      if (!path.isAbsolute(f) || /[\r\n]/.test(f) || !(await lstat(f)).isFile())
        fail("model_file_unavailable");
    }
}
export async function manage(
  service: Service,
  input: ManagementInput,
): Promise<unknown> {
  const { command, resourceID, dryRun = false, yes = false } = input;
  const [resource, action] = command.split(" ");
  const name =
    resourceID === undefined || command === "runs search"
      ? undefined
      : id.parse(resourceID);
  const raw = input.request ?? {};
  if (command === "config reload")
    return { changed: !dryRun, ...(await service.reloadRegistry(dryRun)) };
  if (command === "skills read") {
    const request = requestSchemas[command]!.parse(raw) as { runID?: string };
    if (request.runID) await service.storage.reconcile();
    const skills = request.runID
      ? (await service.run(request.runID)).skills
      : [...service.skills.values()];
    const { runID, ...selection } = request;
    return loadSkillContent(skills, selection);
  }
  if (command === "agents cache clear") {
    service.agent(name ?? fail("missing_id"));
    if (!service.runtime.contextCache)
      fail("cache_management_unavailable", 503);
    if (!yes && !dryRun)
      fail("confirmation_required");
    return service.runtime.contextCache!(
      "agent-" + createHash("sha256").update(name!).digest("hex"),
      true,
      dryRun,
    );
  }
  if (command === "evals release") {
    const chat = service.chat(name ?? fail("missing_id"));
    if (!chat.evalOptions || !["completed", "failed", "cancelled", "timedOut"].includes(chat.state)) fail("eval_not_terminal");
    if (!dryRun) service.chats.delete(chat.requestID);
    return { changed: !dryRun };
  }
  if (command === "evals sample") {
    const request = operationInputs["evals sample"].parse(raw);
    if (dryRun) return { changed: false, request };
    return service.submitChat(request, { sampling: request.sampling });
  }
  if (resource === "instant") {
    if (action === "unload") return service.unloadInstant(dryRun);
    if (action === "submit") {
      if (dryRun)
        return { changed: false, request: requestSchemas[command]!.parse(raw) };
      return service.submitChat(
        requestSchemas[command]!.parse(
          raw,
        ) as import("./contracts.js").ChatInput,
      );
    }
    if (action === "get") {
      return service.chatDetail(service.chat(name ?? fail("missing_id")));
    }
    if (action === "cancel")
      return service.cancelChat(name ?? fail("missing_id"), dryRun);
  }
  if (command === "scheduler explain") return service.explainScheduler();
  if (resource === "triggers") {
    if (action === "fire") {
      const value = requestSchemas[command]!.parse(raw) as {
        occurrenceID?: string;
        message?: Omit<import("./contracts.js").UserMessage, "messageID">;
      };
      return service.fireTrigger(
        name ?? fail("missing_id"),
        value.occurrenceID ?? randomUUID(),
        value.message,
        dryRun,
      );
    }
    if (action === "list" || action === "get") {
      await service.storage.reconcile();
      const runs: Run[] = [];
      for (const summary of service.storage.summaries.values())
        if (!terminal(summary.state))
          runs.push(await service.run(summary.runID));
      const inspect = (trigger: z.infer<typeof triggerSchema>) => {
        const blockers: string[] = [];
        if (!trigger.enabled) blockers.push("trigger_disabled");
        if (!service.agent(trigger.agentID).enabled)
          blockers.push("agent_disabled");
        if (
          trigger.schedule.type !== "manual" &&
          !service.storage.store.config.scheduler.timersEnabled
        )
          blockers.push("timers_disabled");
        if (
          trigger.queuePolicy === "skip" &&
          runs.some(
            (r) => r.triggerSource?.definition.triggerID === trigger.triggerID,
          )
        )
          blockers.push("unfinished_trigger_run");
        return {
          ...trigger,
          nextFireAt: trigger.enabled
            ? nextFireAt(
                trigger.schedule,
                trigger.anchorAt,
                Date.now(),
                checkpoint,
              )
            : null,
          automaticDispatchEnabled:
            service.storage.store.config.scheduler.timersEnabled,
          blockers,
        };
      };
      const triggers = service.storage.store.triggers;
      if (action === "list")
        return {
          items: triggers
            .map(inspect)
            .sort((a, b) => a.triggerID.localeCompare(b.triggerID)),
        };
      return {
        item: inspect(
          triggers.find((t) => t.triggerID === name) ??
            fail("trigger_not_found", 404),
        ),
      };
    }
    return service.storage.exclusive(async () => {
      const value = requestSchemas[command]?.parse(raw) as
        | {
            trigger?: z.infer<typeof triggerDraftSchema>;
            expectedRevision?: number;
            changes?: Partial<z.infer<typeof triggerDraftSchema>>;
          }
        | undefined;
      if (!value) fail("unknown_command");
      const next = structuredClone(service.storage.store);
      const at = now();
      let item: z.infer<typeof triggerSchema> | null;
      if (action === "create") {
        const draft = value!.trigger!;
        if (next.triggers.some((t) => t.triggerID === draft.triggerID))
          fail("trigger_exists", 409);
        item = triggerSchema.parse({
          ...draft,
          revision: 1,
          createdAt: at,
          updatedAt: at,
          anchorAt: at,
        });
        next.triggers.push(item);
      } else {
        const index = next.triggers.findIndex((t) => t.triggerID === name);
        if (index < 0) fail("trigger_not_found", 404);
        const current = next.triggers[index]!;
        if (current.revision !== value!.expectedRevision)
          fail("revision_conflict", 409);
        if (action === "delete") {
          if (!yes && !dryRun) fail("confirmation_required");
          next.triggers.splice(index, 1);
          item = null;
        } else {
          if (action !== "update") fail("unknown_command");
          const changes = value!.changes!;
          const reset =
            (changes.enabled === true && !current.enabled) ||
            (changes.schedule !== undefined &&
              canonical(changes.schedule) !== canonical(current.schedule));
          item = triggerSchema.parse({
            ...current,
            ...changes,
            anchorAt: reset ? at : current.anchorAt,
            revision: current.revision + 1,
            updatedAt: at,
          });
          next.triggers[index] = item;
        }
      }
      storeSchema.parse(next);
      validateConfig(next);
      if (Buffer.byteLength(JSON.stringify(next)) > 8 * 1024 * 1024)
        fail("config_capacity", 413);
      if (!dryRun) await service.storage.saveConfig(next);
      return { item, changed: !dryRun };
    });
  }
  if (command === "config token rotate") {
    if (!yes && !dryRun) fail("confirmation_required");
    return service.storage.exclusive(async () => {
      const token = randomBytes(32).toString("base64url");
      if (!dryRun) {
        const next = structuredClone(service.storage.store);
        next.config.rootTokenHash = tokenHash(token);
        next.config.revision++;
        await service.storage.saveConfig(next);
      }
      return { changed: !dryRun, ...(!dryRun ? { token } : {}) };
    });
  }
  if (command === "status") {
    const runs = [...service.storage.summaries.values()].sort(
      (a, b) =>
        b.updatedAt.localeCompare(a.updatedAt) ||
        a.runID.localeCompare(b.runID),
    );
    const review = runs.filter((r) => r.outcome.needsReview);
    const triggerInfo = (await manage(service, {
      command: "triggers list",
    })) as {
      items: (z.infer<typeof triggerSchema> & {
        nextFireAt: string | null;
        automaticDispatchEnabled: boolean;
        blockers: string[];
      })[];
    };
    return {
      observedAt: now(),
      pid: process.pid,
      ...(operationInputs.status.parse(raw).details ? {scheduler:service.schedulerStatus()} : {}),
      runtime: service.status(),
      totals: {
        runs: runs.length,
        needsReview: review.length,
        activeMs: runs.reduce((n, r) => n + r.activeMs, 0),
      },
      agents: service.storage.store.agents.map((agent) => {
        const own = runs.filter((r) => r.agentID === agent.agentID);
        return {
          agentID: agent.agentID,
          name: agent.name,
          enabled: agent.enabled,
          modelID: agent.modelID,
          latestRun: own[0] ?? null,
          activeRuns: own.filter((r) => !terminal(r.state)).length,
          needsReview: own.filter((r) => r.outcome.needsReview).length,
          activeMs: own.reduce((n, r) => n + r.activeMs, 0),
          triggers: triggerInfo.items.filter(
            (t) => t.agentID === agent.agentID,
          ),
        };
      }),
      review: review.slice(0, 100),
      reviewTruncated: review.length > 100,
    };
  }
  if (command === "config get")
    return { config: exposeConfig(service.storage.store) };
  if (command === "agents create") {
    const value = requestSchemas[command]!.parse(raw) as {
      agent: z.infer<typeof agentDraftSchema>;
    };
    return service.createAgent(value.agent, dryRun);
  }
  if (command === "agents update") {
    const value = requestSchemas[command]!.parse(raw) as {
      expectedRevision: number;
      changes?: Partial<z.infer<typeof agentSchema>>;
    };
    return service.patchAgent(
      name ?? fail("missing_id"),
      value.expectedRevision,
      value.changes ?? {},
      dryRun,
    );
  }
  if (command === "runs capabilities refresh")
    return service.refreshRunCapabilities(name ?? fail("missing_id"), operationInputs[command].parse(raw).expectedRevision, dryRun);
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
    return service.annotateRun(name ?? fail("missing_id"), operationInputs[command].parse(raw), dryRun);
  if (command === "runs pause")
    return service.pauseRun(name ?? fail("missing_id"), operationInputs[command].parse(raw).expectedRevision, dryRun);
  if (command === "runs resume")
    return service.queueControl(
      name ?? fail("missing_id"),
      "release",
      operationInputs[command].parse(raw).expectedRevision,
      dryRun,
    );
  if (resource === "runs" || command === "agents run") {
    const { userMessageSchema } = await import("./contracts.js");
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
        const entries = service.transcript(await service.run(name ?? fail("missing_id")));
        const items = input.recent ? entries.slice(-input.limit) : entries.filter(e => e.sequence > input.afterSequence!).slice(0, input.limit);
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
      const input = requestSchemas[command]!.parse(raw) as { bundle?: string };
      return verifyRun(service, name ?? fail("missing_id"), input.bundle);
    }
    if (action === "get")
      return {
        run: service.detail(await service.run(name ?? fail("missing_id"))),
      };
  }
  return service.storage.exclusive(async () => {
    const next = structuredClone(service.storage.store);
    const registry = {
      skills: new Map(service.skills),
      tools: new Map(service.tools),
    };
    if (action === "list" || action === "get") {
      const items: unknown[] =
        resource === "agents"
          ? next.agents
          : resource === "models"
            ? next.config.models
            : resource === "slots"
              ? next.config.slots
              : resource === "skills"
                ? [...registry.skills.values()].map((x) => ({
                    ...x,
                    hash: fingerprint(x),
                  }))
                : resource === "tools"
                  ? [...registry.tools.values()].map((x) => ({
                      ...x,
                      hash: fingerprint(x),
                      builtin: builtinTools.some((t) => t.toolID === x.toolID),
                    }))
                  : fail("unknown_command");
      if (action === "list") return { items };
      const item =
        items.find(
          (x) =>
            (x as Record<string, unknown>)[resource!.slice(0, -1) + "ID"] ===
            name,
        ) ?? fail("not_found", 404);
      if (resource === "agents") {
        const cache = await service.runtime.contextCache?.(
          "agent-" + createHash("sha256").update(name!).digest("hex"), false, false,
        );
        return { item, cache: cache ? { contextID: cache.contextID, items: cache.items } : null };
      }
      if (resource === "models") return { item, capabilities: (await capabilities(service.storage.home, next)).models.find(m => m.modelID === name)! };
      return { item };
    }
    if (action === "delete" && !yes && !dryRun) fail("confirmation_required");
    const parsed =
      requestSchemas[command]?.parse(raw) ?? fail("unknown_command");
    const value = parsed as Record<string, unknown>;
    if (resource === "agents" && action === "delete") {
      const agent = service.agent(name ?? fail("missing_id"));
      if (agent.revision !== value.expectedRevision)
        fail("revision_conflict", 409);
      next.agents = next.agents.filter((a) => a.agentID !== name);
    } else if (
      resource === "config" ||
      resource === "models" ||
      resource === "slots"
    ) {
      if (
        value.expectedRevision !== undefined &&
        next.config.revision !== value.expectedRevision
      )
        fail("revision_conflict", 409);
      const liveSettingsOnly =
        resource === "config" &&
        Object.keys(value.changes as object).every((k) =>
          ["logging", "interactionCooldownMs", "scheduler", "httpEnabled"].includes(k),
        );
      if (!liveSettingsOnly && service.status().queue.length)
        fail("runtime_busy", 409);
      if (resource === "config") {
        const changes = value.changes as Partial<typeof next.config>;
        if (Object.keys(changes).length === 0) fail("empty_changes");
        if (changes.scheduler) {
          const resizing = ["maxConcurrent", "contextTokens", "instantModelID"].some(k => Object.hasOwn(changes.scheduler!, k));
          if (resizing && (service.schedulerStatus().active.length || [...service.chats.values()].some(c => c.state === "queued"))) fail("runtime_busy",409);
          if (changes.scheduler.contextTokens !== undefined) next.config.slots = next.config.slots.map(slot => ({...slot,contextTokens:changes.scheduler!.contextTokens!}));
          changes.scheduler = {...next.config.scheduler,...changes.scheduler};
        }
        next.config = { ...next.config, ...changes };
      } else if (resource === "models") {
        if (action === "create") {
          const model = modelSchema.parse(value.model);
          if (next.config.models.some((m) => m.modelID === model.modelID))
            fail("already_exists", 409);
          next.config.models.push(model);
          const slots = z.array(slotSchema).parse(value.slots);
          if (slots.some((s) => s.modelID !== model.modelID))
            fail("invalid_slot");
          next.config.slots.push(...slots);
        } else {
          const index = next.config.models.findIndex((m) => m.modelID === name);
          if (index < 0) fail("not_found", 404);
          if (action === "delete") {
            next.config.models.splice(index, 1);
            next.config.slots = next.config.slots.filter(
              (s) => s.modelID !== name,
            );
          } else
            next.config.models[index] = modelSchema.parse({
              ...next.config.models[index],
              ...(value.changes as object),
            });
        }
      } else {
        if (action === "create") {
          const slot = slotSchema.parse(value.slot);
          if (next.config.slots.some((s) => s.slotID === slot.slotID))
            fail("already_exists", 409);
          next.config.slots.push(slot);
        } else {
          const index = next.config.slots.findIndex((s) => s.slotID === name);
          if (index < 0) fail("not_found", 404);
          if (action === "delete") next.config.slots.splice(index, 1);
          else
            next.config.slots[index] = slotSchema.parse({
              ...next.config.slots[index],
              ...(value.changes as object),
            });
        }
      }
      next.config.revision++;
      if (
        resource !== "config" ||
        (value.changes as Record<string, unknown>).models !== undefined
      )
        await verifyModels(next);
    } else if (resource === "skills" || resource === "tools") {
      const isSkill = resource === "skills";
      let item =
        action === "delete"
          ? null
          : isSkill
            ? canonicalSkill(skillSchema.parse(value.skill))
            : toolDefinitionSchema.parse(value.tool);
      const itemID = item
        ? "skillID" in item
          ? item.skillID
          : item.toolID
        : (name ?? fail("missing_id"));
      if (name && name !== itemID) fail("identity_immutable");
      if (!isSkill && builtinTools.some((t) => t.toolID === itemID))
        fail("builtin_tool_immutable");
      const current = isSkill
        ? registry.skills.get(itemID)
        : registry.tools.get(itemID);
      if (
        isSkill &&
        action === "update" &&
        item &&
        current &&
        !(value.skill as { files?: unknown }).files
      )
        item = skillSchema.parse({
          ...item,
          files: (current as import("./contracts.js").Skill).files,
        });
      if (action === "create" && current) fail("already_exists", 409);
      if (action !== "create" && !current) fail("not_found", 404);
      if (action !== "create" && fingerprint(current) !== value.expectedHash)
        fail("revision_conflict", 409);
      if (isSkill) {
        if (item) registry.skills.set(itemID, skillSchema.parse(item));
        else registry.skills.delete(itemID);
      } else {
        if (item) registry.tools.set(itemID, toolDefinitionSchema.parse(item));
        else registry.tools.delete(itemID);
      }
      validateRegistry(next.agents, registry.skills, registry.tools);
      if (!dryRun) {
        checkpoint();
        const root = path.join(service.storage.home, resource!);
        await mkdir(root, { recursive: true, mode: 0o700 });
        if (isSkill) {
          await writeSkillFolder(
            root,
            item ? skillSchema.parse(item) : null,
            itemID,
          );
        } else {
          const file = path.join(root, itemID + ".json");
          if (item) await atomicJSON(file, item, 128 * 1024);
          else {
            checkpoint();
            await unlink(file);
          }
        }
        await service.reloadRegistry();
      }
      return {
        changed: !dryRun,
        item: item ? { ...item, hash: fingerprint(item) } : null,
      };
    } else fail("unknown_command");
    validateConfig(next);
    validateRegistry(next.agents, registry.skills, registry.tools);
    if (!dryRun) {
      const liveSettingsOnly =
        resource === "config" &&
        Object.keys(value.changes as object).every((k) =>
          ["logging", "interactionCooldownMs", "scheduler", "httpEnabled"].includes(k),
        );
      const schedulerChanges = resource === "config" ? (value.changes as {scheduler?:Record<string,unknown>}).scheduler : undefined;
      const resizingScheduler = schedulerChanges && ["maxConcurrent", "contextTokens", "instantModelID"].some(k => Object.hasOwn(schedulerChanges,k));
      if ((resource !== "agents" && !liveSettingsOnly) || resizingScheduler)
        await service.runtime.close();
      await service.storage.saveConfig(next);
    }
    return {
      changed: !dryRun,
      restartRequired:
        resource === "config" &&
        ((value.changes as Record<string, unknown>).httpEnabled !== undefined ||
          (value.changes as Record<string, unknown>).host !== undefined ||
          (value.changes as Record<string, unknown>).port !== undefined),
      config: exposeConfig(next),
      ...(resource === "agents" ? { agentID: name } : {}),
    };
  });
}
