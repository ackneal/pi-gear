import { Type } from "typebox";
import { runChildSubagent, type RunChildSubagentOptions } from "../../runtime/runner.ts";
import type { SubagentRun } from "../../runtime/types.ts";
import { researcherProfile } from "./profile.ts";

export const RESEARCHER_TOOL_NAME = researcherProfile.id;

export interface ResearcherSubagentInput {
  question: string;
  scope: string | undefined;
}

export const researcherParameters = Type.Object({
  question: Type.String({ description: "The research question to answer." }),
  scope: Type.Optional(
    Type.String({ description: "Sources, files, or constraints to focus on." }),
  ),
});

/** Serializes the structured researcher input into the user input sent to the child pi. */
export function formatResearcherInput(input: ResearcherSubagentInput): string {
  const lines: string[] = [`Question: ${input.question}`];
  if (input.scope) lines.push(`Scope: ${input.scope}`);
  return lines.join("\n");
}

export function runResearcher(
  task: string,
  options: Omit<RunChildSubagentOptions, "task" | "profile" | "childExtension">,
): Promise<SubagentRun> {
  return runChildSubagent({
    ...options,
    profile: researcherProfile,
    childExtension: new URL("./extension.ts", import.meta.url),
    task,
  });
}

export { researcherProfile } from "./profile.ts";
