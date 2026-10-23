import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EXECUTION_POLICY =
  "Use request_command to request approval for commands that need user authorization or host execution, including host credentials unavailable in the sandbox. " +
  "Call the tool with the command and reason instead of asking the user to copy and run it. " +
  "A sandbox availability, setup, or credential failure may justify requesting host approval; it does not grant permission to execute. " +
  "Never use host execution or manual instructions to bypass a user denial or policy restriction. After a denial or cancellation, stop that command unless the user explicitly asks to reconsider it. " +
  "Provide manual steps only when request_command is unavailable, the user asks for instructions, or the command requires an interactive terminal. " +
  "Do not repeat a command that already succeeded.";
const PLAN_POLICY =
  "Use task_state for multi-step tasks that require tracking progress. " +
  "Mark a step complete only after its doneWhen condition is met. " +
  "Update the plan only when the remaining steps are no longer valid.";
const RESEARCH_POLICY = "Use subagent_spawn_research for focused read-only research needing authoritative or current sources. Preserve exact identifiers and quoted terms in delegated questions. Ask one bounded question; require a conclusion, evidence, and uncertainty. Researchers do not modify files or state; you own decisions and changes. Parallelize independent research. Avoid trivial delegation.";
const WORKER_POLICY = "For non-trivial work, use subagent_spawn_work to speed up two or more independent ready tasks with disjoint files. Do not parallelize dependencies or overlapping edits. Workers should satisfy focused completion checks. Keep integration and final verification in the main agent.";
const REVIEW_POLICY = "Use subagent_spawn_review for independent read-only review when requested or after non-trivial code changes pass focused checks. Pass the change scope, requirements or intent in context, and applicable coding or review skill paths in skills. Avoid trivial delegation. Reviewer does not modify files; evaluate findings, fix confirmed issues, and re-verify in the main agent.";
const SUBAGENT_POLICY = "Do independent work before observing. Use bounded subagent_observe calls and avoid repeated polling. Observe healthy runs again as needed. Cancel or redispatch narrower work when stalled, repeatedly failing, unnecessary, or over budget. Do not edit an active worker's targetFiles. Subagents do not inherit the parent agent's skills; provide the absolute path of any skill needed for the delegated task.";

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
  const execution = selectedTools.includes("request_command");
  const plan = selectedTools.includes("task_state");
  const research = selectedTools.includes("subagent_spawn_research");
  const worker = selectedTools.includes("subagent_spawn_work");
  const reviewer = selectedTools.includes("subagent_spawn_review");
  if (!execution && !plan && !research && !worker && !reviewer) return base;

  const sections: string[] = [];
  if (execution) sections.push(`Execution:\n${EXECUTION_POLICY}`);
  if (plan) sections.push(`Plan:\n${PLAN_POLICY}`);
  if (research) sections.push(`Research:\n${RESEARCH_POLICY}`);
  if (worker) sections.push(`Worker:\n${WORKER_POLICY}`);
  if (reviewer) sections.push(`Review:\n${REVIEW_POLICY}`);
  if (research || worker || reviewer) sections.push(`Subagents:\n${SUBAGENT_POLICY}`);

  return `${base}\n\n<pi_gear_context>\n${sections.join("\n\n")}\n</pi_gear_context>`;
}
