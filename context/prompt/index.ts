import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLAN_POLICY = "Use task_state to externalize and maintain the authoritative state for non-trivial work: one goal; 3–7 outcome-based todos, each with a verifiable doneWhen. Capture requirements and boundaries as constraints, and decision-relevant evidence as findings. Update the state as work progresses and replan when evidence changes. If current task progress is uncertain or conversation context may have been compacted, use task_state with action=show to recover the authoritative state. Clear only when starting a new task.";
const RESEARCH_POLICY = "Use researcher for focused read-only research needing authoritative or current sources. Preserve exact identifiers and quoted terms in delegated questions. Ask one bounded question; require a conclusion, evidence, and uncertainty. Researchers do not modify files or state; you own decisions and changes. Parallelize independent research. Avoid trivial delegation.";
const WORKER_POLICY = "Worker calls block. For non-trivial work, use workers to speed up two or more independent ready tasks: dispatch them together with disjoint files and clear completion checks. Do not parallelize dependencies or overlapping edits. Keep integration and final verification in the main agent.";

export function setupPromptComposer(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => ({
    systemPrompt: composePrompt(
      event.systemPrompt,
      event.systemPromptOptions.selectedTools,
    ),
  }));
}

export function composePrompt(
  systemPrompt: string,
  selectedTools: string[] | undefined,
): string {
  const ownedBlock = /\n*<pi_gear_context>[\s\S]*?<\/pi_gear_context>\n*/;
  const base = ownedBlock.test(systemPrompt)
    ? systemPrompt.replace(/\n*<pi_gear_context>[\s\S]*?<\/pi_gear_context>\n*/g, "\n").trimEnd()
    : systemPrompt;

  if (selectedTools === undefined) return base;
  const plan = selectedTools.includes("task_state");
  const research = selectedTools.includes("researcher");
  const worker = selectedTools.includes("worker");
  if (!plan && !research && !worker) return base;

  const sections: string[] = [];
  if (plan) sections.push(`Plan:\n${PLAN_POLICY}`);
  if (research) sections.push(`Research:\n${RESEARCH_POLICY}`);
  if (worker) sections.push(`Worker:\n${WORKER_POLICY}`);

  return `${base}\n\n<pi_gear_context>\n${sections.join("\n\n")}\n</pi_gear_context>`;
}
