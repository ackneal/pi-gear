import type { SupervisionWakeTrigger } from "../agents/schema.ts";

export type TaskStatus = "pending" | "running" | "blocked" | "completed" | "failed" | "aborted";

export type TaskUsage = {
  input: number;
  output: number;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  cacheWrite1h?: number | undefined;
  reasoning?: number | undefined;
  totalTokens?: number | undefined;
  estimated?: boolean | undefined;
  cost?: {
    input?: number | undefined;
    output?: number | undefined;
    cacheRead?: number | undefined;
    cacheWrite?: number | undefined;
    total?: number | undefined;
  } | undefined;
};

export type TaskActivity =
  | { kind: "thinking"; text: string; contentIndex?: number; messageId?: number }
  | { kind: "tool"; id?: string; name: string; args?: Record<string, unknown>; status: "running" | "success" | "error"; result?: string }
  | { kind: "message"; role: "user" | "assistant"; text: string };

export interface TaskRecord {
  readonly id: string;
  readonly agentId: string;
  readonly task: string;
  readonly parentTaskId?: string | undefined;
  readonly depth: number;
  readonly targetFiles: readonly string[];
  readonly wakeOn: readonly SupervisionWakeTrigger[];
  cancellationCause?: "abort" | "stalled" | undefined;
  status: TaskStatus;
  revision: number;
  readonly createdAt: number;
  startedAt?: number | undefined;
  finishedAt?: number | undefined;
  lastActivityAt: number;
  result?: string | undefined;
  error?: string | undefined;
  usage?: TaskUsage | undefined;
  activities: TaskActivity[];
  activitiesTruncated?: boolean | undefined;
  toolActivitiesTruncated?: boolean | undefined;
  readonly timeoutSeconds?: number | undefined;
}

export interface TaskFilter {
  agentId?: string | undefined;
  status?: TaskStatus | TaskStatus[] | undefined;
  parentTaskId?: string | undefined;
}
