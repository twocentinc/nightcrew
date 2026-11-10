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
} from "./contracts.js";
import { Service, fail } from "./service.js";
import { atomicJSON, canonical, tokenHash } from "./storage.js";
import {
  toolDefinitionSchema,
  validateRegistry,
  builtinTools,
} from "./registry.js";
import { requestSchemas } from "./protocol.js";
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
  const name = resourceID === undefined ? undefined : id.parse(resourceID);
  const raw = input.request ?? {};
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
    if (action === "list") return { items: await service.listRuns() };
    if (action === "get")
      return {
        run: service.detail(await service.run(name ?? fail("missing_id"))),
      };
    if (action === "transcript")
      return {
        items: service.transcript(
          await service.run(name ?? fail("missing_id")),
        ),
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
      const loggingOnly =
        resource === "config" &&
        Object.keys(value.changes as object).every((k) => k === "logging");
      if (!loggingOnly && service.status().queue.length)
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
      await verifyModels(next);
    } else if (resource === "skills" || resource === "tools") {
      const isSkill = resource === "skills";
      const item =
        action === "delete"
          ? null
          : isSkill
            ? skillSchema.parse(value.skill)
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
          const folder = path.join(root, itemID);
          const file = path.join(folder, "SKILL.md");
          if (item) {
            const skill = skillSchema.parse(item);
            await mkdir(folder, { recursive: true, mode: 0o700 });
            const temp = path.join(folder, "." + randomUUID() + ".tmp");
            await writeFile(
              temp,
              "---\nname: " +
                JSON.stringify(skill.name) +
                "\ndescription: " +
                JSON.stringify(skill.description) +
                "\ntools:\n" +
                skill.toolIDs.map((t) => "  - " + t + "\n").join("") +
                "---\n" +
                skill.instructions,
              { mode: 0o600, flag: "wx" },
            );
            try {
              checkpoint();
              await rename(temp, file);
            } finally {
              await unlink(temp).catch(() => {});
            }
          } else {
            checkpoint();
            await unlink(file);
          }
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
      const loggingOnly =
        resource === "config" &&
        Object.keys(value.changes as object).every((k) => k === "logging");
      if (resource !== "agents" && !loggingOnly) await service.runtime.close();
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
