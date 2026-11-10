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
  if (command === "skills reload")
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
  if (command === "presence status")
    return {
      presence: service.presence,
      cooldownUntil: service.storage.store.cooldownUntil,
    };
  if (command === "agents cache" || command === "agents reset-cache") {
    service.agent(name ?? fail("missing_id"));
    if (!service.runtime.contextCache)
      fail("cache_management_unavailable", 503);
    if (command === "agents reset-cache" && !yes && !dryRun)
      fail("confirmation_required");
    return service.runtime.contextCache!(
      "agent-" + createHash("sha256").update(name!).digest("hex"),
      command === "agents reset-cache",
      dryRun,
    );
  }
  if (resource === "inference") {
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
  if (resource === "scheduler") {
    if (action === "get")
      return {
        configRevision: service.storage.store.config.revision,
        settings: service.storage.store.config.scheduler,
      };
    if (action === "status") return service.schedulerStatus();
    if (action === "explain") return service.explainScheduler();
    if (action === "update")
      return service.storage.exclusive(async () => {
        const input = requestSchemas[command]!.parse(raw) as {
          expectedRevision: number;
          changes: Partial<import("./scheduler.js").SchedulerConfig>;
        };
        const next = structuredClone(service.storage.store);
        if (next.config.revision !== input.expectedRevision)
          fail("revision_conflict", 409);
        const resizing =
          input.changes.maxConcurrent !== undefined ||
          input.changes.contextTokens !== undefined ||
          input.changes.instantModelID !== undefined;
        if (
          resizing &&
          (service.schedulerStatus().active.length ||
            [...service.chats.values()].some((c) => c.state === "queued"))
        )
          fail("runtime_busy", 409);
        next.config.scheduler = { ...next.config.scheduler, ...input.changes };
        next.config.revision++;
        if (input.changes.contextTokens !== undefined)
          next.config.slots = next.config.slots.map((s) => ({
            ...s,
            contextTokens: input.changes.contextTokens!,
          }));
        storeSchema.parse(next);
        validateConfig(next);
        if (!dryRun) {
          if (resizing) await service.runtime.close();
          await service.storage.saveConfig(next);
        }
        return {
          changed: !dryRun,
          configRevision: next.config.revision,
          settings: next.config.scheduler,
        };
      });
  }
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
          const changes =
            action === "update"
              ? value!.changes!
              : { enabled: action === "enable" };
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
  if (resource === "queue") {
    if (action === "list") {
      const input = requestSchemas[command]!.parse(raw) as {
        limit: number;
        cursor?: string;
        agentID?: string;
        state?: string;
      };
      return service.page(
        "queue:" + canonical([input.agentID ?? null, input.state ?? null]),
        input,
        async () =>
          (await service.listRuns(input.agentID, input.state)).filter(
            (r) => r.state === "queued" || r.state === "paused",
          ),
      );
    }
    if (action === "get") {
      const run = await service.run(name ?? fail("missing_id"));
      if (run.state !== "queued" && run.state !== "paused")
        fail("run_not_pending", 409);
      return { run: service.detail(run) };
    }
    if (action === "hold" || action === "release" || action === "cancel") {
      const value = requestSchemas[command]!.parse(raw) as {
        expectedRevision: number;
      };
      return service.queueControl(
        name ?? fail("missing_id"),
        action,
        value.expectedRevision,
        dryRun,
      );
    }
    fail("unknown_command");
  }
  if (command === "slots save" || command === "slots restore") {
    if (!name) fail("slot_required");
    if (service.status().queue.length) fail("runtime_busy", 409);
    if (!service.runtime.snapshot) fail("snapshots_unsupported", 503);
    return service.runtime.snapshot!(
      name!,
      action as "save" | "restore",
      dryRun,
    );
  }
  if (command === "auth rotate") {
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
  if (command === "daemon status")
    return { pid: process.pid, ...service.status() };
  if (command === "config get")
    return { config: exposeConfig(service.storage.store) };
  if (command === "agents create") {
    const value = requestSchemas[command]!.parse(raw) as {
      agent: z.infer<typeof agentDraftSchema>;
    };
    return service.createAgent(value.agent, dryRun);
  }
  if (
    command === "agents update" ||
    command === "agents enable" ||
    command === "agents disable"
  ) {
    const value = requestSchemas[command]!.parse(raw) as {
      expectedRevision: number;
      changes?: Partial<z.infer<typeof agentSchema>>;
    };
    return service.patchAgent(
      name ?? fail("missing_id"),
      value.expectedRevision,
      value.changes ?? { enabled: action === "enable" },
      dryRun,
    );
  }
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
          ["logging", "interactionCooldownMs"].includes(k),
        );
      if (!liveSettingsOnly && service.status().queue.length)
        fail("runtime_busy", 409);
      if (resource === "config") {
        const changes = value.changes as Partial<typeof next.config>;
        if (Object.keys(changes).length === 0) fail("empty_changes");
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
          ["logging", "interactionCooldownMs"].includes(k),
        );
      if (resource !== "agents" && !liveSettingsOnly)
        await service.runtime.close();
      await service.storage.saveConfig(next);
    }
    return {
      changed: !dryRun,
      restartRequired:
        resource === "config" &&
        ((value.changes as Record<string, unknown>).host !== undefined ||
          (value.changes as Record<string, unknown>).port !== undefined),
      config: exposeConfig(next),
      ...(resource === "agents" ? { agentID: name } : {}),
    };
  });
}
