import { RESEARCH_MCP_CAPABILITIES, type CapabilitySpec } from "../../../capabilities/index.ts";
import type { SubagentProfile } from "../../runtime/types.ts";
import { RESEARCHER_SYSTEM_PROMPT } from "./prompt.ts";

export const RESEARCHER_CAPABILITIES = [{ kind: "builtin", name: "read" }, ...RESEARCH_MCP_CAPABILITIES] as const satisfies readonly CapabilitySpec[];
export const researcherProfile: SubagentProfile = { id: "researcher", label: "researcher", description: "Delegate a focused read-only research task to an isolated Pi subprocess.", systemPrompt: RESEARCHER_SYSTEM_PROMPT, capabilities: RESEARCHER_CAPABILITIES, presentation: { activity: { starting: "Researching", complete: "Research complete", drafting: "Drafting research", failed: "Research failed", aborted: "Research aborted" } } };
