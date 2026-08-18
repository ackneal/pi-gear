import type { CapabilitySpec } from "../../../capabilities/index.ts";
import type { SubagentProfile } from "../../runtime/types.ts";
import { WORKER_SYSTEM_PROMPT } from "./prompt.ts";

export const WORKER_CAPABILITIES = [
  { kind: "builtin", name: "read" },
  { kind: "builtin", name: "edit" },
  { kind: "builtin", name: "write" },
  { kind: "builtin", name: "bash" },
] as const satisfies readonly CapabilitySpec[];

export const workerProfile: SubagentProfile = {
  id: "worker",
  label: "worker",
  description: "Delegate a bounded implementation task to an isolated Pi subprocess.",
  systemPrompt: WORKER_SYSTEM_PROMPT,
  capabilities: WORKER_CAPABILITIES,
  presentation: {
    activity: {
      starting: "Working",
      complete: "Work complete",
      drafting: "Preparing result",
      failed: "Work failed",
      aborted: "Work aborted",
    },
  },
};
