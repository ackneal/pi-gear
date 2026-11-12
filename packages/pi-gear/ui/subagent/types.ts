import type { TaskSnapshot } from "../../subagents/runtime/types.ts";

/** Missing UI state is not evidence that the runtime aborted a task. */
export type TaskViewSnapshot = Omit<TaskSnapshot, "status"> & {
  status: TaskSnapshot["status"] | "unknown";
};
