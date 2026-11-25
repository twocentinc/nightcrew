import { lstat, mkdir, unlink } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  builtinTools,
  toolDefinitionSchema,
  validateRegistry,
} from "../engine/capabilities/registry.js";
import {
  canonicalSkill,
  writeSkillFolder,
} from "../engine/capabilities/skills.js";
import { checkpoint } from "../engine/execution/process.js";
import { Service, fail } from "../engine/service.js";
import { skillSchema } from "../schemas/agent.js";
import { id } from "../schemas/common.js";
import { validateConfig, type Store } from "../schemas/config.js";
import { atomicJSON } from "../storage/files.js";
import { fingerprint } from "../utils/json.js";

export type ManagementInput = {
  command: string;
  resourceID?: string;
  request?: unknown;
  dryRun?: boolean;
  yes?: boolean;
};
export function exposeConfig(store: Store) {
  const { rootTokenHash, ...config } = store.config;
  return config;
}
export async function verifyModels(store: Store) {
  for (const m of store.config.models)
    for (const f of [m.weightsPath, m.projectorPath].filter(
      (s): s is string => s !== null,
    )) {
      if (!path.isAbsolute(f) || /[\r\n]/.test(f) || !(await lstat(f)).isFile())
        fail("model_file_unavailable");
    }
}
export async function resourceCommand(
  service: Service,
  input: ManagementInput,
  requestSchemas: Record<string, z.ZodType>,
  actions: ResourceActions,
): Promise<unknown> {
  const { command, resourceID, dryRun = false, yes = false } = input;
  const [resource, action] = command.split(" ");
  const name =
    resourceID === undefined || command === "runs search"
      ? undefined
      : id.parse(resourceID);
  const raw = input.request ?? {};
  return service.storage.exclusive(async () => {
    const next = structuredClone(service.storage.store);
    const registry = {
      skills: new Map(service.skills),
      tools: new Map(service.tools),
    };
    const context: ResourceContext = {
      service,
      input,
      next,
      registry,
      resource: resource!,
      action: action!,
      name,
      dryRun,
      value: {},
    };
    if (action === "list" || action === "get")
      return actions.read?.(context) ?? fail("unknown_command");
    if (action === "delete" && !yes && !dryRun) fail("confirmation_required");
    const parsed =
      requestSchemas[command]?.parse(raw) ?? fail("unknown_command");
    const value = parsed as Record<string, unknown>;
    const result = await actions.mutate({ ...context, value });
    if (result !== undefined) return result;
    validateConfig(next);
    validateRegistry(next.agents, registry.skills, registry.tools);
    if (!dryRun) {
      if (configurationChangePolicy(resource!, value.changes).closeRuntime)
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
export type ResourceContext = {
  service: Service;
  input: ManagementInput;
  next: Store;
  registry: {
    skills: Map<string, import("../schemas/agent.js").Skill>;
    tools: Map<string, z.infer<typeof toolDefinitionSchema>>;
  };
  resource: string;
  action: string;
  name: string | undefined;
  dryRun: boolean;
  value: Record<string, unknown>;
};
export type ResourceActions = {
  read?: (context: ResourceContext) => Promise<unknown>;
  mutate: (context: ResourceContext) => Promise<unknown>;
};
export async function mutateRegistration({
  service,
  next,
  registry,
  resource,
  action,
  name,
  dryRun,
  value,
}: ResourceContext): Promise<unknown> {
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
    !(
      value.skill as {
        files?: unknown;
      }
    ).files
  )
    item = skillSchema.parse({
      ...item,
      files: (current as import("../schemas/agent.js").Skill).files,
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
}
/** Shared policy only; callers keep their existing admission checks and write order. */
export function configurationChangePolicy(resource: string, value: unknown) {
  const changes = (value ?? {}) as Record<string, unknown>;
  const liveSettingsOnly =
    resource === "config" &&
    Object.keys(changes).every((key) =>
      ["logging", "interactionCooldownMs", "scheduler", "httpEnabled"].includes(
        key,
      ),
    );
  const scheduler =
    resource === "config"
      ? (changes.scheduler as Record<string, unknown> | undefined)
      : undefined;
  const resizingScheduler =
    !!scheduler &&
    ["maxConcurrent", "contextTokens", "instantModelID"].some((key) =>
      Object.hasOwn(scheduler, key),
    );
  return {
    requiresIdleQueue: !liveSettingsOnly,
    resizingScheduler,
    closeRuntime:
      (resource !== "agents" && !liveSettingsOnly) || resizingScheduler,
  };
}
