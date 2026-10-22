import { Type } from "typebox";
import { withoutWorkspaceSearch } from "../../runtime/process.ts";
import { runChildSubagent, type RunChildSubagentOptions } from "../../runtime/runner.ts";
import type { SubagentRun } from "../../runtime/types.ts";
import { reviewerProfile } from "./profile.ts";

export const REVIEWER_TOOL_NAME = "subagent_spawn_review";

export interface ReviewerSubagentInput {
  scope: string;
  context: string | undefined;
  skills: string[] | undefined;
}

export const reviewerParameters = Type.Object({
  scope: Type.String({ description: "Changes, files, commits, or focus area to review." }),
  context: Type.Optional(
    Type.String({ description: "Requirements, specification, or intent behind the changes." }),
  ),
  skills: Type.Optional(
    Type.Array(Type.String(), { description: "Absolute paths to skill files to load and apply during review." }),
  ),
});

/** Serializes the structured reviewer input into the user input sent to the child pi. */
export function formatReviewerInput(input: ReviewerSubagentInput): string {
  const lines: string[] = [`Scope: ${input.scope}`];
  if (input.context) lines.push(`Context: ${input.context}`);
  if (input.skills?.length) {
    lines.push("Skills:", ...input.skills.map((skill) => `- ${skill}`));
  }
  return lines.join("\n");
}

export function runReviewer(
  task: string,
  options: Omit<RunChildSubagentOptions, "task" | "profile" | "childExtension"> & { workspaceSearch?: boolean },
): Promise<SubagentRun> {
  const { workspaceSearch = true, ...runOptions } = options;
  return runChildSubagent({
    ...runOptions,
    profile: workspaceSearch ? reviewerProfile : withoutWorkspaceSearch(reviewerProfile),
    childExtension: new URL("../../../index.ts", import.meta.url),
    task,
  });
}

export { reviewerProfile } from "./profile.ts";
