import { randomUUID } from "node:crypto";
import { now, type Message } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import type { Attempt, Result } from "../models/types.js";
import type { Inference, RunExecution } from "./inference.js";
import type { PreparedTurn } from "./request.js";

interface Dependencies {
  readonly inference: Pick<Inference, "clearProvisional">;
  readonly storage: Storage;
  readonly records: Pick<RunRecords, "save" | "event">;
}
export class ResponseRecorder {
  constructor(private readonly ports: Dependencies) {}
  responseContinuation(run: Run) {
    const chunks: Attempt[] = [];
    for (const attempt of [...run.attempts].reverse()) {
      if (attempt.segment !== run.segment || attempt.messageID) break;
      if (attempt.reason === "output_limit") chunks.unshift(attempt);
    }
    return chunks;
  }
  async recordOutput(
    r: Run,
    runID: string,
    result: Result,
    history: TurnHistory,
    prepared: PreparedTurn,
    state: RunExecution,
  ) {
    const { continuation, prefix, priorReasoning } = history;
    const { thinking, finalizing } = prepared;
    const attempt = state.attempt!;
    if (r.contextUsage) {
      r.contextUsage = {
        ...r.contextUsage,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        measuredAt: now(),
        segment: r.segment,
      };
    }
    if (result.outputLimitReached) {
      // These attempts are durable continuation chunks, not complete messages.
      // They survive interruption/restart/compaction without completing the run
      // or executing unfinished tool calls. No new user turn/budget is created.
      attempt.text = result.text;
      attempt.reasoningContent = thinking
        ? (result.reasoningContent ?? "")
        : "";
      attempt.status = "interrupted";
      attempt.reason = "output_limit";
      attempt.updatedAt = now();
      state.attempt = undefined;
      this.ports.inference.clearProvisional(runID);
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
      if (
        !attempt.text &&
        !attempt.reasoningContent &&
        !attempt.toolCalls.length
      )
        throw Error("Output continuation made no progress");
      if (
        Buffer.byteLength(prefix + attempt.text) > 1048576 ||
        Buffer.byteLength(priorReasoning + attempt.reasoningContent) > 1048576
      )
        throw Error("Assembled response exceeds storage limit");
      return;
    }
    const content = prefix + result.text;
    const reasoningContent =
      priorReasoning + (thinking ? (result.reasoningContent ?? "") : "");
    if (
      Buffer.byteLength(content) > 1048576 ||
      Buffer.byteLength(reasoningContent) > 1048576
    )
      throw Error("Assembled response exceeds storage limit");
    const m: Message = {
      messageID: randomUUID(),
      role: "assistant",
      content,
      thinking: thinking || continuation.some((a) => a.thinking),
      ...(reasoningContent ? { reasoningContent } : {}),
      attachments: [],
      toolCalls: result.toolCalls,
      toolCallID: null,
    };
    if (
      Buffer.byteLength(JSON.stringify(r)) +
        Buffer.byteLength(JSON.stringify(m)) >
        56 * 1024 * 1024 ||
      r.messages.length >= 9990 ||
      r.events.length >= 19900
    )
      throw Error("Run capacity");
    r.messages.push(m);
    for (const chunk of continuation) chunk.messageID = m.messageID;
    if (state.attempt) {
      state.attempt.status = "completed";
      state.attempt.messageID = m.messageID;
      state.attempt.updatedAt = now();
      state.attempt.text = "";
      state.attempt.reasoningContent = "";
      state.attempt.toolCalls = [];
      state.attempt = undefined;
    }
    this.ports.inference.clearProvisional(runID);
    this.ports.records.event(r, "message", { messageID: m.messageID });
    if (!result.toolCalls.length) {
      if (r.agent.mode === "agent-loop" && !result.text.trim()) {
        if (finalizing) throw Error("Model returned no visible final answer");
        await this.ports.storage.exclusive(() => this.ports.records.save(r));
        return;
      }
      await this.ports.storage.exclusive(() => this.ports.records.save(r));
      return;
    }
    if (finalizing && !r.agent.finishSchema)
      throw Error("Model requested tools during tool-free finalization");
    if (r.agent.mode === "single-turn" && !r.agent.finishSchema)
      throw Error("Unexpected tools");
    await this.ports.storage.exclusive(() => this.ports.records.save(r));
  }
}
export interface TurnHistory {
  currentMessages: Message[];
  lastAssistant: Message | undefined;
  continuation: Attempt[];
  prefix: string;
  priorReasoning: string;
}
