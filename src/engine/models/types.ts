import { z } from "zod";
import { type Agent } from "../../schemas/agent.js";
import { type ChatInput, type Message } from "../../schemas/common.js";
import { attemptSchema } from "../../schemas/run.js";

export type Result = {
  outputLimitReached?: boolean;
  text: string;
  reasoningContent?: string;
  toolCalls: Message["toolCalls"];
  usage: { inputTokens: number; outputTokens: number };
};
export type Attempt = z.infer<typeof attemptSchema>;
export type PartialOutput = Pick<Attempt, "reasoningContent" | "toolCalls">;
export interface Runtime {
  initialize?(): Promise<void>;
  countTokens?(
    input: Parameters<Runtime["generate"]>[0],
    signal: AbortSignal,
  ): Promise<number>;
  keepWarm?(until: number): void;
  contextCache?(
    contextID: string,
    reset: boolean,
    dryRun: boolean,
  ): Promise<{
    contextID: string;
    items: Array<{ modelID: string; bytes: number; updatedAt: string }>;
    changed: boolean;
  }>;
  isBusy?(): boolean;
  snapshot?(
    slotID: string,
    action: "save" | "restore",
    dryRun: boolean,
  ): Promise<{
    slotID: string;
    action: string;
    changed: boolean;
    directory: string;
  }>;
  generate(
    input: {
      modelID: string;
      slotID: string;
      contextID?: string;
      persistContext?: boolean;
      contextEpoch?: number;
      messages: Message[];
      tools: ChatInput["tools"];
      thinking?: boolean;
      reasoningBudgetTokens?: number;
      continueOnOutputLimit?: boolean;
      continueFinalMessage?: boolean;
      maxOutputTokens: number;
      temperature: number;
      sampling?: Agent["sampling"];
    },
    signal: AbortSignal,
    onDelta?: (text: string) => void,
    onEvidence?: (output: PartialOutput) => void,
  ): Promise<Result>;
  // Must settle only after owned computation has stopped, including on abort.
  close(): Promise<void>;
  status(): { modelID: string; state: string }[];
}
export type Presence = {
  state: "present" | "away";
  reason: string;
  samplingHealthy: boolean;
  observedAt: string;
  diagnostic: string | null;
};
