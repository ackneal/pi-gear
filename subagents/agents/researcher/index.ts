import { runChildSubagent, type RunChildSubagentOptions } from "../../runtime/runner.ts";
import type { SubagentRun } from "../../runtime/types.ts";
import { researcherProfile } from "./profile.ts";

export const RESEARCHER_TOOL_NAME = researcherProfile.id;
export function runResearcher(options: Omit<RunChildSubagentOptions, "profile" | "childExtension">): Promise<SubagentRun> { return runChildSubagent({ ...options, profile: researcherProfile, childExtension: new URL("./extension.ts", import.meta.url) }); }
export { researcherProfile } from "./profile.ts";
