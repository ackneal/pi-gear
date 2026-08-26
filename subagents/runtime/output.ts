import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { BackgroundSnapshot, WaitReason } from "./background.ts";

export interface CompactSubagentOutput {
  reason?: WaitReason;
  runId: string;
  status: BackgroundSnapshot["status"];
  revision: number;
  idleSeconds: number;
  noProgressSeconds: number;
  activeTools: string[];
  toolCalls: number;
  toolErrors: number;
  consecutiveToolErrors: number;
  latestUpdate?: string;
  result?: string;
  partialResult?: string;
  error?: string;
}

export function subagentControlResult(snapshot: BackgroundSnapshot, reason?: WaitReason): AgentToolResult<CompactSubagentOutput> {
  const compact = compactSubagentOutput(snapshot, reason);
  return {
    content: [{ type: "text", text: JSON.stringify(compact) }],
    details: compact,
    ...(snapshot.usage ? { usage: snapshot.usage as any } : {}),
  };
}

export function compactSubagentOutput(snapshot: BackgroundSnapshot, reason?: WaitReason): CompactSubagentOutput {
  const failed = snapshot.status === "error" || snapshot.status === "aborted";
  return {
    ...(reason ? { reason } : {}),
    runId: snapshot.runId,
    status: snapshot.status,
    revision: snapshot.revision,
    idleSeconds: snapshot.idleSeconds,
    noProgressSeconds: snapshot.noProgressSeconds,
    activeTools: snapshot.activeTools,
    toolCalls: snapshot.toolCalls,
    toolErrors: snapshot.toolErrors,
    consecutiveToolErrors: snapshot.consecutiveToolErrors,
    ...(snapshot.latestUpdate ? { latestUpdate: snapshot.latestUpdate } : {}),
    ...(snapshot.status === "success" && snapshot.run.result ? { result: snapshot.run.result } : {}),
    ...(failed && snapshot.partialResult ? { partialResult: snapshot.partialResult } : {}),
    ...(failed && snapshot.run.error ? { error: snapshot.run.error } : {}),
  };
}
