import type { SubagentRun } from "../../subagents/runtime/types.ts";

/** Missing UI state is not evidence that the runtime aborted a task. */
export type SubagentViewRun = Omit<SubagentRun, "status"> & {
  status: SubagentRun["status"] | "unknown";
};
