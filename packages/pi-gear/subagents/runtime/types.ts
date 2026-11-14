import type { CapabilitySpec } from "../../capabilities/index.ts";

export type SubagentActivity =
  | { kind: "thinking"; text: string; contentIndex?: number; messageId?: number }
  | { kind: "tool"; id?: string; name: string; args?: Record<string, unknown>; status: "running" | "success" | "error"; result?: string };
export interface TaskSnapshot {
  status: "running" | "success" | "error" | "aborted";
  startedAt: number;
  finishedAt?: number;
  lastActivityAt?: number;
  activities: SubagentActivity[];
  activitiesTruncated?: boolean;
  toolActivitiesTruncated?: boolean;
  modelSelection?: ModelSelection;
  result?: string;
  modelError?: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    reasoning?: number;
    totalTokens?: number;
    estimated?: boolean;
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
export interface ModelSelection { model?: string; thinkingLevel?: ThinkingLevel; }
export interface RunSubagentOptions { task: string; profile: SubagentProfile; modelSelection?: ModelSelection; signal?: AbortSignal; onUpdate: (run: TaskSnapshot) => void; }
