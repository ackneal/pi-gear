import type { TaskRecord } from "pi-rostrix";
import type { SubagentDispatch, SubagentRun } from "./runtime/types.ts";

/** Keep runtime snapshots and live UI updates on the same projection. */
export function taskRun(task: TaskRecord, dispatch?: SubagentDispatch): SubagentRun {
  const usage = task.usage;
  return {
    status: task.status === "completed" ? "success"
      : task.status === "failed" ? "error"
      : task.status === "aborted" ? "aborted" : "running",
    startedAt: task.startedAt ?? task.createdAt,
    lastActivityAt: task.lastActivityAt,
    items: task.items.filter((item) => item.kind !== "message"),
    ...(task.finishedAt !== undefined ? { finishedAt: task.finishedAt } : {}),
    ...(task.itemsTruncated !== undefined ? { itemsTruncated: task.itemsTruncated } : {}),
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(dispatch ? { dispatch } : {}),
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
