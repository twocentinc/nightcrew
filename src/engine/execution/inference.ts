import { randomUUID } from "node:crypto";
import { now } from "../../schemas/common.js";
import { type Run } from "../../schemas/run.js";
import type { RunRecords } from "../../storage/records.js";
import { Storage } from "../../storage/store.js";
import type { Attempt, Runtime } from "../models/types.js";

interface Dependencies {
  readonly records: Pick<RunRecords, "event" | "save">;
  readonly storage: Storage;
  readonly runtime: Runtime;
}
export class Inference {
  constructor(private readonly ports: Dependencies) {}
  readonly provisional = new Map<string, { attemptID: string; text: string }>();
  deltas(id: string) {
    const value = { attemptID: randomUUID(), text: "" };
    this.provisional.set(id, value);
    return (text: string) => {
      if (Buffer.byteLength(value.text) + Buffer.byteLength(text) > 1048576)
        throw Error("Output limit");
      value.text += text;
    };
  }
  clearProvisional(id: string) {
    this.provisional.delete(id);
  }
  async startAttempt(r: Run, thinking: boolean, state: RunExecution) {
    state.attempt = {
      attemptID: randomUUID(),
      turnID: r.turnID,
      startedAt: now(),
      updatedAt: now(),
      status: "running",
      reason: null,
      thinking,
      text: "",
      reasoningContent: "",
      toolCalls: [],
      truncated: false,
      messageID: null,
    };
    r.attempts.push(state.attempt);
    this.ports.records.event(r, "attempt", {
      attemptID: state.attempt.attemptID,
    });
    await this.ports.storage.exclusive(() => this.ports.records.save(r));
    return state.attempt!;
  }
  async generate(
    runID: string,
    input: Parameters<Runtime["generate"]>[0],
    controller: AbortController,
    attempt: Attempt,
    thinking: boolean,
  ) {
    const delta = this.deltas(runID);
    const result = await this.ports.runtime.generate(
      input,
      controller.signal,
      (text) => {
        attempt.updatedAt = now();
        attempt.text += text;
        if (Buffer.byteLength(attempt.text) > 1048576) {
          attempt.text = Buffer.from(attempt.text)
            .subarray(0, 1048576)
            .toString();
          attempt.truncated = true;
          throw Error("Output limit");
        }
        delta(text);
      },
      (output) => {
        attempt.updatedAt = now();
        if (thinking) {
          attempt.reasoningContent = Buffer.from(output.reasoningContent)
            .subarray(0, 1048576)
            .toString();
          if (Buffer.byteLength(output.reasoningContent) > 1048576)
            attempt.truncated = true;
        }
        attempt.toolCalls = output.toolCalls.slice(0, 32).map((c) => ({
          index: c.index,
          callID: c.callID.slice(0, 128),
          name: c.name.slice(0, 128),
          arguments: c.arguments.slice(0, 64000),
        }));
        if (
          output.toolCalls.some(
            (c) =>
              c.arguments.length > 64000 ||
              c.name.length > 128 ||
              c.callID.length > 128,
          )
        )
          attempt.truncated = true;
      },
    );
    return result;
  }
}
export interface RunExecution {
  attempt?: Attempt;
}
