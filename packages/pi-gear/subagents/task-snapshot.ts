import type { TaskRecord } from "pi-rostrix";
import type { ModelSelection, TaskSnapshot } from "./runtime/types.ts";

/** Keep runtime snapshots and live UI updates on the same projection. */
export function toTaskSnapshot(task: TaskRecord, modelSelection?: ModelSelection): TaskSnapshot {
  const usage = task.usage;
  return {
    status: task.status === "completed" ? "success"
      : task.status === "failed" ? "error"
      : task.status === "aborted" ? "aborted" : "running",
    startedAt: task.startedAt ?? task.createdAt,
    lastActivityAt: task.lastActivityAt,
    activities: task.activities.filter((activity) => activity.kind !== "message"),
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.activitiesTruncated !== undefined ? { activitiesTruncated: task.activitiesTruncated } : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    ...(usage ? { usage: {
      input: usage.input,
      output: usage.output,
      ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
      ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
      ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
      ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
      ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
      ...(usage.cost ? { cost: {
        ...(usage.cost.input !== undefined ? { input: usage.cost.input } : {}),
        ...(usage.cost.output !== undefined ? { output: usage.cost.output } : {}),
        ...(usage.cost.cacheRead !== undefined ? { cacheRead: usage.cost.cacheRead } : {}),
        ...(usage.cost.cacheWrite !== undefined ? { cacheWrite: usage.cost.cacheWrite } : {}),
        ...(usage.cost.total !== undefined ? { total: usage.cost.total } : {}),
      } } : {}),
    } } : {}),
  };
}
