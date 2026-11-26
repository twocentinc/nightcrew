import { ModelOperations, type ModelTestInput } from "./models/operations.js";
import type { EvalDefinition } from "./evals/format.js";
import { type Agent } from "../schemas/agent.js";
import { type ChatInput, type UserMessage } from "../schemas/common.js";
import { type Config } from "../schemas/config.js";
import { type Run } from "../schemas/run.js";
import type { OperationalLog } from "../server/logging.js";
import { RunRecords } from "../storage/records.js";
import { Storage } from "../storage/store.js";
import { AgentRegistry, builtinTools } from "./capabilities/registry.js";
import { Compaction } from "./compaction/coordinator.js";
import { Configuration } from "./configuration.js";
import { Completion } from "./execution/completion.js";
import { Context } from "./execution/context.js";
import { Inference } from "./execution/inference.js";
import { RequestBuilder } from "./execution/request.js";
import { ResponseRecorder } from "./execution/response.js";
import { Runner } from "./execution/runner.js";
import { ToolExecution } from "./execution/tools.js";
import { Hooks } from "./hooks.js";
import { Instant, type Chat } from "./instant/requests.js";
import type { Presence, Runtime } from "./models/types.js";
import { Runs } from "./runs/submissions.js";
import { Dispatch } from "./scheduling/dispatch.js";
import { type SchedulerSnapshot } from "./scheduling/policy.js";

export type {
  Attempt,
  PartialOutput,
  Presence,
  Result,
  Runtime,
} from "./models/types.js";
export { fail } from "./protocol.js";
export const tools = builtinTools;

export class Service {
  private readonly models: ModelOperations;
  private readonly request: RequestBuilder;
  private readonly inference: Inference;
  private readonly response: ResponseRecorder;
  private readonly toolStep: ToolExecution;
  private readonly completion: Completion;
  private readonly compaction: Compaction;
  private readonly registry: AgentRegistry;
  private readonly records: RunRecords;
  private readonly configuration: Configuration;
  private readonly runs: Runs;
  private readonly runner: Runner;
  private readonly instant: Instant;
  private readonly context: Context;
  private readonly hooks: Hooks;
  private readonly dispatch: Dispatch;
  constructor(
    readonly storage: Storage,
    readonly runtime: Runtime,
    readonly samplePresence: () => Promise<Presence>,
    logger?: OperationalLog,
  ) {
    // Forward getters wire cyclic orchestration dependencies without exposing Service.
    // Constructors only retain dependencies; execution begins in initialize().
    let registry: AgentRegistry;
    let records: RunRecords;
    let configuration: Configuration;
    let runs: Runs;
    let runner: Runner;
    let instant: Instant;
    let context: Context;
    let hooks: Hooks;
    let dispatch: Dispatch;
    let compaction: Compaction;
    this.registry = registry = new AgentRegistry({ storage });
    this.records = records = new RunRecords({ storage });
    this.configuration = configuration = new Configuration({
      storage,
      registry,
    });
    this.runs = runs = new Runs({
      storage,
      get instant() {
        return instant;
      },
      get dispatch() {
        return dispatch;
      },
      records,
      configuration,
      get runner() {
        return runner;
      },
      get context() {
        return context;
      },
      get hooks() {
        return hooks;
      },
      registry,
    });
    this.context = context = new Context({ records });
    this.inference = new Inference({ storage, records, runtime });
    this.request = new RequestBuilder({ storage, records, context, registry });
    this.response = new ResponseRecorder({
      storage,
      records,
      inference: this.inference,
    });
    this.toolStep = new ToolExecution({ storage, records, context, registry });
    this.completion = new Completion({
      storage,
      records,
      context,
      get dispatch() {
        return dispatch;
      },
      get hooks() {
        return hooks;
      },
    });
    this.runner = runner = new Runner({
      storage,
      records,
      context,
      get compaction() {
        return compaction;
      },
      inference: this.inference,
      request: this.request,
      response: this.response,
      tools: this.toolStep,
      completion: this.completion,
    });
    this.instant = instant = new Instant({
      inference: this.inference,
      storage,
      registry,
      get dispatch() {
        return dispatch;
      },
      runner,
      records,
      runtime,
    });
    this.compaction = compaction = new Compaction({
      records,
      context,
      storage,
      runtime,
      get dispatch() {
        return dispatch;
      },
      configuration,
    });
    this.hooks = hooks = new Hooks({
      storage,
      records,
      get dispatch() {
        return dispatch;
      },
      runner,
    });
    this.dispatch = dispatch = new Dispatch({
      inference: this.inference,
      storage,
      instant,
      runtime,
      runner,
      logger,
      samplePresence,
      records,
      compaction,
      runs,
    });
    this.models = new ModelOperations({ storage, runtime, dispatch });
  }
  submitEval(definition: EvalDefinition, revision: number, dryRun = false) {
    return this.runs.submitEval(definition, revision, dryRun);
  }
  get skills() {
    return this.registry.skills;
  }
  get tools() {
    return this.registry.tools;
  }
  get chats() {
    return this.instant.chats;
  }
  get provisional() {
    return this.inference.provisional;
  }
  get presence() {
    return this.dispatch.presence;
  }
  set presence(value: Presence) {
    this.dispatch.presence = value;
  }
  reloadRegistry(dryRun = false) {
    return this.registry.reloadRegistry(dryRun);
  }
  publicConfig(
    config: Omit<Config, "rootTokenHash"> & { rootTokenHash?: string } = this
      .storage.store.config,
  ) {
    return this.configuration.publicConfig(config);
  }
  status() {
    return this.dispatch.status();
  }
  agent(agentID: string) {
    return this.configuration.agent(agentID);
  }
  run(runID: string) {
    return this.records.run(runID);
  }
  detail(r: Run) {
    return this.records.detail(r);
  }
  validateAgent(a: Agent) {
    return this.registry.validateAgent(a);
  }
  createAgent(
    draft: Omit<Agent, "revision" | "createdAt" | "updatedAt">,
    dryRun = false,
  ) {
    return this.configuration.createAgent(draft, dryRun);
  }
  patchAgent(
    agentID: string,
    expectedRevision: number,
    changes: Partial<Agent>,
    dryRun = false,
  ) {
    return this.configuration.patchAgent(
      agentID,
      expectedRevision,
      changes,
      dryRun,
    );
  }
  page<T>(
    key: string,
    input: { limit: number; cursor?: string },
    items: () => Promise<T[]> | T[],
  ) {
    return this.records.page(key, input, items);
  }
  listRuns(agentID?: string, state?: string) {
    return this.records.listRuns(agentID, state);
  }
  transcript(r: Run) {
    return this.records.transcript(r);
  }
  search(query: string, agentID?: string, state?: string) {
    return this.records.search(query, agentID, state);
  }
  submit(target: string, message: UserMessage, reply = false, dryRun = false) {
    return this.runs.submit(target, message, reply, dryRun);
  }
  fireTrigger(
    triggerID: string,
    occurrenceID: string,
    replacement: Omit<UserMessage, "messageID"> | undefined,
    dryRun: boolean,
    scheduled = false,
  ) {
    return this.runs.fireTrigger(
      triggerID,
      occurrenceID,
      replacement,
      dryRun,
      scheduled,
    );
  }
  refreshRunCapabilities(
    runID: string,
    expectedRevision: number,
    dryRun = false,
  ) {
    return this.runs.refreshRunCapabilities(runID, expectedRevision, dryRun);
  }
  retryRun(
    runID: string,
    input: { expectedRevision: number; messageID: string; note: string },
    dryRun: boolean,
  ) {
    return this.runs.retryRun(runID, input, dryRun);
  }
  retryHook(
    runID: string,
    input: {
      expectedRevision: number;
      receiptID: string;
      requestID: string;
      note: string;
      acceptUnknown: boolean;
    },
    dryRun: boolean,
  ) {
    return this.hooks.retryHook(runID, input, dryRun);
  }
  pauseRun(runID: string, expectedRevision: number, dryRun: boolean) {
    return this.runs.pauseRun(runID, expectedRevision, dryRun);
  }
  queueControl(
    runID: string,
    action: "hold" | "release" | "cancel",
    expectedRevision: number,
    dryRun: boolean,
  ) {
    return this.runs.queueControl(runID, action, expectedRevision, dryRun);
  }
  cancelRun(runID: string, dryRun = false) {
    return this.runs.cancelRun(runID, dryRun);
  }
  deleteChat(requestID: string, dryRun = false) {
    return this.instant.deleteChat(requestID, dryRun);
  }
  chat(requestID: string) {
    return this.instant.chat(requestID);
  }
  chatDetail(c: Chat) {
    return this.instant.chatDetail(c);
  }
  submitChat(request: ChatInput) {
    return this.instant.submitChat(request);
  }
  testModel(modelID: string, input: ModelTestInput, dryRun = false) {
    return this.models.test(modelID, input, dryRun);
  }
  unloadModels(modelID: string | undefined, all: boolean, dryRun = false) {
    return this.models.unload(modelID, all, dryRun);
  }
  cancelChat(requestID: string, dryRun = false) {
    return this.instant.cancelChat(requestID, dryRun);
  }
  schedulerSnapshot(): Promise<SchedulerSnapshot> {
    return this.dispatch.schedulerSnapshot();
  }
  explainScheduler() {
    return this.dispatch.explainScheduler();
  }
  schedulerStatus() {
    return this.dispatch.schedulerStatus();
  }
  async initialize() {
    await this.storage.initialize();
    try {
      await this.runtime.initialize?.();
      await this.reloadRegistry();
      await this.storage.exclusive(async () => {
        const next = structuredClone(this.storage.store);
        next.cooldownUntil = new Date(
          Math.max(
            Date.parse(next.cooldownUntil ?? "") || 0,
            Date.now() + next.config.interactionCooldownMs,
          ),
        ).toISOString();
        await this.storage.saveConfig(next);
        await this.records.recoverInterrupted();
      });
      for (const a of this.storage.store.agents) this.validateAgent(a);
      for (const summary of this.storage.summaries.values()) {
        const r = await this.records.run(summary.runID);
        if (
          r.evaluation?.grade.status === "pending" &&
          ["completed", "failed", "cancelled", "timedOut"].includes(r.state)
        )
          this.hooks.scheduleHooks(r);
      }
      await this.dispatch.start();
    } catch (e) {
      await this.storage.close();
      throw e;
    }
  }
  async close() {
    await this.dispatch.stop();
    await this.runtime.close();
    await this.hooks.drain();
    await this.storage.close();
  }
}
