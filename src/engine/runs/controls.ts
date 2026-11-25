import { now, terminal } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import { canonical } from "../../utils/json.js";
import { fail } from "../protocol.js";
import type {
  Dependencies as ParentDependencies,
  Runs,
} from "./submissions.js";

interface Dependencies {
  readonly dependencies: Pick<
    ParentDependencies,
    | "storage"
    | "records"
    | "dispatch"
    | "configuration"
    | "registry"
    | "context"
    | "runner"
    | "hooks"
  >;
  readonly main: Pick<Runs, "acceptance" | "submitLocked">;
}
export class RunControls {
  constructor(private readonly ports: Dependencies) {}
  async refreshRunCapabilities(
    runID: string,
    expectedRevision: number,
    dryRun = false,
  ) {
    return this.ports.dependencies.storage.exclusive(async () => {
      const run = await this.ports.dependencies.records.run(runID);
      if (run.revision !== expectedRevision) fail("revision_conflict", 409);
      if (
        !terminal(run.state) ||
        this.ports.dependencies.dispatch.hasActivity(runID) ||
        run.pendingInputs.some((p) => !p.cancelled)
      )
        fail("run_not_idle", 409);
      const configured = this.ports.dependencies.configuration.agent(
        run.agent.agentID,
      );
      const candidate = {
        ...run.agent,
        toolIDs: [...configured.toolIDs],
        skillIDs: [...configured.skillIDs],
      };
      this.ports.dependencies.registry.validateAgent(candidate);
      const skills = candidate.skillIDs.map((id) =>
        structuredClone(this.ports.dependencies.registry.skills.get(id)!),
      );
      const tools = this.ports.dependencies.registry
        .agentToolIDs(candidate)
        .map((id) =>
          JSON.parse(
            JSON.stringify(this.ports.dependencies.registry.tools.get(id)),
          ),
        );
      const changed =
        canonical({
          toolIDs: run.agent.toolIDs,
          skillIDs: run.agent.skillIDs,
          skills: run.skills,
          tools: run.toolSnapshots,
        }) !==
        canonical({
          toolIDs: candidate.toolIDs,
          skillIDs: candidate.skillIDs,
          skills,
          tools,
        });
      if (changed && !dryRun) {
        if (run.capabilityRefreshes.length >= 100)
          fail("capability_refresh_limit", 409);
        run.capabilityRefreshes.push({
          at: now(),
          segment: run.segment,
          sourceAgentRevision: configured.revision,
          previousToolIDs: run.agent.toolIDs,
          previousSkillIDs: run.agent.skillIDs,
          previousTools: run.toolSnapshots,
          previousSkills: run.skills,
        });
        run.agent = candidate;
        run.skills = skills;
        run.toolSnapshots = tools;
        run.contextUsage = null;
        if (this.ports.dependencies.context.atStorageLimit(run))
          fail("run_capacity", 507);
        await this.ports.dependencies.records.save(run);
      }
      return {
        runID,
        revision: run.revision,
        changed: changed && !dryRun,
        toolIDs: candidate.toolIDs,
        skillIDs: candidate.skillIDs,
      };
    });
  }
  async retryRun(
    runID: string,
    input: { expectedRevision: number; messageID: string; note: string },
    dryRun: boolean,
  ) {
    const result = await this.ports.dependencies.storage.exclusive(async () => {
      const run = await this.ports.dependencies.records.run(runID);
      const prior = run.events.find(
        (e) =>
          e.type === "retried" &&
          (e.data as { messageID?: string })?.messageID === input.messageID,
      );
      if (prior) {
        if ((prior.data as { note: string }).note !== input.note)
          fail("message_conflict", 409);
        return this.ports.main.acceptance(run, true);
      }
      if (run.revision !== input.expectedRevision)
        fail("revision_conflict", 409);
      if (
        !terminal(run.state) ||
        this.ports.dependencies.dispatch.hasActivity(runID)
      )
        fail("run_not_terminal", 409);
      if (run.parentRunID) fail("compactor_retry_requires_parent", 409);
      if (run.pendingInputs.some((p) => !p.cancelled))
        fail("pending_inputs_exist", 409);
      const previous = run.messages.filter((m) => m.role === "user").at(-1);
      if (!previous) fail("message_missing", 409);
      return this.ports.main.submitLocked(
        runID,
        {
          messageID: input.messageID,
          content: previous.content,
          attachments: previous.attachments,
          ...(previous.thinking === undefined
            ? {}
            : { thinking: previous.thinking }),
        },
        true,
        dryRun,
        null,
        input.note,
      );
    });
    if (!dryRun) this.ports.dependencies.dispatch.wake();
    return result;
  }
  async pauseRun(runID: string, expectedRevision: number, dryRun: boolean) {
    const run = await this.ports.dependencies.records.run(runID);
    if (run.revision !== expectedRevision) fail("revision_conflict", 409);
    if (terminal(run.state)) fail("run_not_pending", 409);
    const activity = this.ports.dependencies.dispatch.activity(runID);
    if (activity) {
      if (dryRun)
        return {
          run: this.ports.dependencies.records.detail(run),
          changed: false,
        };
      // Set the live hold before aborting so the scheduler cannot restart it.
      const live = this.ports.dependencies.runner.liveRun(runID);
      if (live) live.held = true;
      activity.abort("manual");
      await activity.task;
      return {
        run: this.ports.dependencies.records.detail(
          await this.ports.dependencies.records.run(runID),
        ),
        changed: true,
      };
    }
    return this.queueControl(runID, "hold", expectedRevision, dryRun);
  }
  async queueControl(
    runID: string,
    action: "hold" | "release" | "cancel",
    expectedRevision: number,
    dryRun: boolean,
  ) {
    const result = await this.ports.dependencies.storage.exclusive(async () => {
      const run = await this.ports.dependencies.records.run(runID);
      if (run.revision !== expectedRevision) fail("revision_conflict", 409);
      if (
        this.ports.dependencies.dispatch.hasActivity(runID) ||
        (run.state !== "queued" && run.state !== "paused")
      )
        fail("run_not_pending", 409);
      const changed = action === "cancel" || run.held !== (action === "hold");
      if (changed && !dryRun) {
        if (action === "cancel") {
          run.state = "cancelled";
          for (const p of run.pendingInputs) p.cancelled = true;
          run.pauseReason = null;
          this.ports.dependencies.records.event(run, "cancelled", {});
        } else {
          if (action === "release" && run.pauseReason === "storage_limit") {
            const updated = {
              ...run,
              agent: {
                ...run.agent,
                storageLimitMB: this.ports.dependencies.configuration.agent(
                  run.agent.agentID,
                ).storageLimitMB,
              },
            };
            if (this.ports.dependencies.context.atStorageLimit(updated))
              fail("run_storage_limit", 409);
            run.agent.storageLimitMB = updated.agent.storageLimitMB;
            const boundary = [...run.events]
              .reverse()
              .find((e) => e.type === "storageLimit");
            const prior = (
              boundary?.data as { previousState?: Run["state"] } | null
            )?.previousState;
            if (prior && terminal(prior)) run.state = prior;
            run.pauseReason = null;
            run.error = null;
          }
          run.held = action === "hold";
          if (action === "release" && run.pauseReason === "context_full") {
            run.compaction = null;
            run.agent.compaction = structuredClone(
              this.ports.dependencies.configuration.agent(run.agent.agentID)
                .compaction,
            );
            run.error = null;
            run.pauseReason = null;
          }
          if (action === "release" && run.pauseReason === "runtime_error") {
            if (run.compaction?.childRunID) {
              const child = await this.ports.dependencies.records.run(
                run.compaction.childRunID,
              );
              if (child.pauseReason === "runtime_error") {
                child.held = false;
                child.pauseReason = null;
                child.error = null;
                this.ports.dependencies.records.event(child, "released", {
                  parentRunID: run.runID,
                });
                await this.ports.dependencies.records.save(child);
              }
            }
            run.error = null;
            run.pauseReason = null;
          }
          this.ports.dependencies.records.event(
            run,
            run.held ? "held" : "released",
            {},
          );
        }
        await this.ports.dependencies.records.save(run);
      }
      return {
        run: this.ports.dependencies.records.detail(run),
        changed: changed && !dryRun,
      };
    });
    if (result.changed && action === "cancel")
      this.ports.dependencies.hooks.scheduleHooks(
        await this.ports.dependencies.records.run(runID),
      );
    if (result.changed) this.ports.dependencies.dispatch.wake();
    return result;
  }
  async cancelRun(runID: string, dryRun = false) {
    const r = await this.ports.dependencies.records.run(runID);
    if (terminal(r.state) || dryRun)
      return { runID, status: r.state, changed: false };
    if (this.ports.dependencies.dispatch.hasActivity(runID)) {
      this.ports.dependencies.dispatch.activity(runID)!.abort("cancelled");
      await this.ports.dependencies.dispatch.activity(runID)!.task;
      return {
        runID,
        status: (await this.ports.dependencies.records.run(runID)).state,
        changed: true,
      };
    }
    const outcome = await this.ports.dependencies.storage.exclusive(
      async () => {
        const current = await this.ports.dependencies.records.run(runID);
        if (terminal(current.state))
          return { runID, status: current.state, changed: false };
        current.state = "cancelled";
        for (const p of current.pendingInputs) p.cancelled = true;
        current.pauseReason = null;
        this.ports.dependencies.records.event(current, "cancelled", {});
        await this.ports.dependencies.records.save(current);
        return { runID, status: current.state, changed: true };
      },
    );
    if (outcome.changed) {
      this.ports.dependencies.hooks.scheduleHooks(
        await this.ports.dependencies.records.run(runID),
      );
      this.ports.dependencies.dispatch.wake();
    }
    return outcome;
  }
}
