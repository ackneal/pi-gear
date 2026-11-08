import type { CapabilitySpec } from "../../../capabilities/index.ts";
import type { SubagentProfile } from "../../runtime/types.ts";
import { REVIEWER_SYSTEM_PROMPT } from "./prompt.ts";

export const REVIEWER_CAPABILITIES = [
  { kind: "builtin", name: "read" },
  { kind: "builtin", name: "find" },
  { kind: "builtin", name: "grep" },
  { kind: "builtin", name: "bash" },
] as const satisfies readonly CapabilitySpec[];

export const reviewerProfile: SubagentProfile = {
  id: "reviewer",
  label: "reviewer",
  description: "Delegate focused read-only code review.",
  systemPrompt: REVIEWER_SYSTEM_PROMPT,
  capabilities: REVIEWER_CAPABILITIES,
  presentation: {
    activity: {
      starting: "Reviewing",
      complete: "Review complete",
      drafting: "Drafting review",
      failed: "Review failed",
      aborted: "Review aborted",
    },
  },
};
