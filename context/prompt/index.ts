import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PLAN_POLICY = "Use task_state for non-trivial work. Complete outcome steps only when their doneWhen is satisfied; prefer the smallest useful check before dependent work proceeds. Replan when evidence changes.";
const RESEARCH_POLICY = "Use researcher for focused read-only research needing authoritative or current sources. Preserve exact identifiers and quoted terms in delegated questions. Ask one bounded question; require a conclusion, evidence, and uncertainty. Researchers do not modify files or state; you own decisions and changes. Parallelize independent research. Avoid trivial delegation.";
const WORKER_POLICY = "For non-trivial work, use workers to speed up two or more independent ready tasks with disjoint files. Do not parallelize dependencies or overlapping edits. Workers should satisfy focused completion checks. Keep integration and final verification in the main agent.";
const SUBAGENT_POLICY = "Do independent work before observing. Use bounded subagent_observe calls and avoid repeated polling. Observe healthy runs again as needed. Cancel or redispatch narrower work when stalled, repeatedly failing, unnecessary, or over budget. Do not edit an active worker's targetFiles.";

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
    ? systemPrompt.replace(new RegExp(ownedBlock.source, "g"), "\n").trimEnd()
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
  if (research || worker) sections.push(`Subagents:\n${SUBAGENT_POLICY}`);

  return `${base}\n\n<pi_gear_context>\n${sections.join("\n\n")}\n</pi_gear_context>`;
}
