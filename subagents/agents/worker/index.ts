import { Type } from "typebox";
import { withoutWorkspaceSearch } from "../../runtime/process.ts";
import { runChildSubagent, type RunChildSubagentOptions } from "../../runtime/runner.ts";
import type { SubagentRun } from "../../runtime/types.ts";
import { workerProfile } from "./profile.ts";

export const WORKER_TOOL_NAME = workerProfile.id;

export interface WorkerSubagentInput {
  task: string;
  targetFiles: string[] | undefined;
  findings: string | undefined;
  verification: string | undefined;
}

export const workerParameters = Type.Object({
  task: Type.String({ description: "The bounded task to complete." }),
  targetFiles: Type.Optional(
    Type.Array(Type.String(), { description: "Intended write scope when the task may modify files. Overlapping active scopes are rejected." }),
  ),
  findings: Type.Optional(
    Type.String({ description: "Known context, constraints, or prior work to build on." }),
  ),
  verification: Type.Optional(
    Type.String({ description: "Expected outcome and focused checks that prove completion." }),
  ),
});

/** Serializes the structured worker input into the user input sent to the child pi. */
export function formatWorkerInput(input: WorkerSubagentInput): string {
  const lines: string[] = [`Task: ${input.task}`];
  if (input.targetFiles?.length) {
    lines.push("Target files:", ...input.targetFiles.map((file) => `- ${file}`));
  }
  if (input.findings) lines.push(`Findings: ${input.findings}`);
  if (input.verification) lines.push(`Verification: ${input.verification}`);
  return lines.join("\n");
}

export function runWorker(
  task: string,
  options: Omit<RunChildSubagentOptions, "task" | "profile" | "childExtension"> & { workspaceSearch?: boolean },
): Promise<SubagentRun> {
  const { workspaceSearch = true, ...runOptions } = options;
  return runChildSubagent({
    ...runOptions,
    profile: workspaceSearch ? workerProfile : withoutWorkspaceSearch(workerProfile),
    childExtension: new URL("./extension.ts", import.meta.url),
    task,
  });
}

export { workerProfile } from "./profile.ts";
