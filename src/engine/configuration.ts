import { agentSchema, type Agent } from "../schemas/agent.js";
import { now } from "../schemas/common.js";
import { validateConfig, type Config } from "../schemas/config.js";
import { Storage } from "../storage/store.js";
import type { AgentRegistry } from "./capabilities/registry.js";
import { fail } from "./protocol.js";

interface Dependencies {
  readonly storage: Storage;
  readonly registry: Pick<AgentRegistry, "validateAgent">;
}
export class Configuration {
  constructor(private readonly ports: Dependencies) {}
  publicConfig(
    config: Omit<Config, "rootTokenHash"> & { rootTokenHash?: string } = this
      .ports.storage.store.config,
  ) {
    const { rootTokenHash, models, hooks, ...rest } = config;
    return {
      ...rest,
      models: models.map(({ weightsPath, projectorPath, ...model }) => model),
      hooks: hooks.map(({ hookID, event, timeoutMs, purpose }) => ({
        hookID,
        event,
        timeoutMs,
        purpose,
      })),
    };
  }
  agent(agentID: string) {
    return (
      this.ports.storage.store.agents.find((a) => a.agentID === agentID) ??
      fail("agent_not_found", 404)
    );
  }
  private valid(store: typeof this.ports.storage.store) {
    try {
      validateConfig(store);
    } catch {
      fail("invalid_configuration");
    }
  }
  async createAgent(
    draft: Omit<Agent, "revision" | "createdAt" | "updatedAt">,
    dryRun = false,
  ) {
    return this.ports.storage.exclusive(async () => {
      if (
        this.ports.storage.store.agents.some((a) => a.agentID === draft.agentID)
      )
        fail("agent_exists", 409);
      const agent = agentSchema.parse({
        ...draft,
        revision: 1,
        createdAt: now(),
        updatedAt: now(),
      });
      this.ports.registry.validateAgent(agent);
      const next = structuredClone(this.ports.storage.store);
      next.agents.push(agent);
      if (agent.contextMode === "persistent") {
        const model = next.config.models.find(
          (m) => m.modelID === agent.modelID,
        );
        if (model && model.kind === "chat" && !model.slotSnapshots.enabled) {
          model.slotSnapshots.enabled = true;
          next.config.revision++;
        }
      }
      this.valid(next);
      if (!dryRun) await this.ports.storage.saveConfig(next);
      return { agent, changed: !dryRun };
    });
  }
  async patchAgent(
    agentID: string,
    agentVersion: number,
    changes: Partial<Agent>,
    dryRun = false,
  ) {
    return this.ports.storage.exclusive(async () => {
      const prev = this.agent(agentID);
      if (prev.revision !== agentVersion) fail("revision_conflict", 409);
      const agent = agentSchema.parse({
        ...prev,
        ...changes,
        revision: prev.revision + 1,
        updatedAt: now(),
      });
      this.ports.registry.validateAgent(agent);
      const next = structuredClone(this.ports.storage.store);
      next.agents = next.agents.map((a) => (a.agentID === agentID ? agent : a));
      if (agent.contextMode === "persistent") {
        const model = next.config.models.find(
          (m) => m.modelID === agent.modelID,
        );
        if (model && model.kind === "chat" && !model.slotSnapshots.enabled) {
          model.slotSnapshots.enabled = true;
          next.config.revision++;
        }
      }
      this.valid(next);
      if (!dryRun) await this.ports.storage.saveConfig(next);
      return { agent, changed: !dryRun };
    });
  }
}
