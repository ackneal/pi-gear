import { runChildSubagent, type RunChildSubagentOptions } from "../../runtime/runner.ts";
import type { SubagentRun } from "../../runtime/types.ts";
import { workerProfile } from "./profile.ts";

export const WORKER_TOOL_NAME = workerProfile.id;
export function runWorker(options: Omit<RunChildSubagentOptions, "profile" | "childExtension">): Promise<SubagentRun> {
  return runChildSubagent({
    ...options,
    profile: workerProfile,
    childExtension: new URL("./extension.ts", import.meta.url),
  });
}
export { workerProfile } from "./profile.ts";
