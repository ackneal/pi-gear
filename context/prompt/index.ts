import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStateHandle } from "../state/index.ts";
import type { TaskState } from "../state/types.ts";

const PLAN_POLICY = "Use task_state to externalize a plan for non-trivial work: one goal; 3–7 outcome-based todos, each with a verifiable doneWhen. Capture requirements and boundaries as constraints, and evidence that affects decisions as findings. Update the plan as work progresses. Replan when evidence changes. Clear only for a new task.";
const RESEARCH_POLICY = "Use researcher for focused read-only research task needing authoritative or current sources, or independent evidence gathering. Ask one bounded question and require evidence. Researchers do not modify files or state; you own decisions and changes. Parallelize independent research. Avoid trivial delegation.";

export function setupPromptComposer(pi: ExtensionAPI, state: TaskStateHandle): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: composePrompt(
      event.systemPrompt,
      event.systemPromptOptions.selectedTools,
      state,
    ),
  }));
}

export function composePrompt(
  systemPrompt: string,
  selectedTools: string[] | undefined,
  state: TaskStateHandle,
): string {
  const ownedBlock = /\n*<pi_gear_context>[\s\S]*?<\/pi_gear_context>\n*/;
  const base = ownedBlock.test(systemPrompt)
    ? systemPrompt.replace(/\n*<pi_gear_context>[\s\S]*?<\/pi_gear_context>\n*/g, "\n").trimEnd()
    : systemPrompt;

  if (selectedTools === undefined) return base;
  const plan = selectedTools.includes("task_state");
  const research = selectedTools.includes("researcher");
  if (!plan && !research) return base;

  const sections: string[] = [];
  if (plan) {
    sections.push(`Plan:\n${PLAN_POLICY}`);
    const current = state.getActiveState();
    if (current !== undefined) {
      sections.push(`<task_state_snapshot>\n${serializeState(current)}\n</task_state_snapshot>`);
    }
  }
  if (research) sections.push(`Research:\n${RESEARCH_POLICY}`);

  return `${base}\n\n<pi_gear_context>\n${sections.join("\n\n")}\n</pi_gear_context>`;
}

function serializeState(state: TaskState): string {
  return JSON.stringify(state).replace(/[<>&]/g, (character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
  })[character]!);
}
