import type { CapabilitySpec } from "../../capabilities/index.ts";

export type SubagentItem =
  | { kind: "thinking"; text: string; contentIndex?: number }
  | { kind: "tool"; id?: string; name: string; args?: Record<string, unknown>; status: "running" | "success" | "error"; result?: string };
export interface SubagentRun {
  status: "running" | "success" | "error" | "aborted";
  startedAt: number;
  finishedAt?: number;
  lastActivityAt?: number;
  items: SubagentItem[];
  result?: string;
  error?: string;
  usage?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
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
export interface RunSubagentOptions { task: string; profile: SubagentProfile; signal?: AbortSignal; onUpdate: (run: SubagentRun) => void; }
