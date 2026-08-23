import type { CapabilitySpec } from "../../capabilities/index.ts";

export type SubagentItem =
  | { kind: "thinking"; text: string; contentIndex?: number; messageId?: number }
  | { kind: "tool"; id?: string; name: string; args?: Record<string, unknown>; status: "running" | "success" | "error"; result?: string };
export interface SubagentRun {
  status: "running" | "success" | "error" | "aborted";
  startedAt: number;
  finishedAt?: number;
  lastActivityAt?: number;
  items: SubagentItem[];
  dispatch?: SubagentDispatch;
  result?: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens?: number;
    cost?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
  };
}
export interface SubagentPresentation { activity?: { starting?: string; complete?: string; drafting?: string; failed?: string; aborted?: string; }; }
export interface SubagentProfile { id: string; label: string; description: string; systemPrompt: string; capabilities: readonly CapabilitySpec[]; presentation?: SubagentPresentation; }
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface SubagentDispatch { model?: string; thinkingLevel?: ThinkingLevel; }
export interface RunSubagentOptions { task: string; profile: SubagentProfile; dispatch?: SubagentDispatch; signal?: AbortSignal; onUpdate: (run: SubagentRun) => void; }
