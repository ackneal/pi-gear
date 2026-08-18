import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { renderSubagentCall, renderSubagentResult } from "../ui/subagent/renderer.ts";
import { RESEARCHER_TOOL_NAME, researcherProfile, runResearcher } from "./agents/researcher/index.ts";
import { WORKER_TOOL_NAME, workerProfile, runWorker } from "./agents/worker/index.ts";
import type { SubagentRun } from "./runtime/types.ts";

export function setupSubagents(pi: ExtensionAPI): void {
  pi.registerTool({
    name: RESEARCHER_TOOL_NAME,
    label: researcherProfile.label,
    description: researcherProfile.description,
    parameters: Type.Object({ task: Type.String() }),
    executionMode: "parallel",
    async execute(_id, { task }, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      let latest: SubagentRun | undefined;
      const run = await runResearcher({
        task,
        cwd: ctx.cwd,
        ...(signal ? { signal } : {}),
        onUpdate: (next) => {
          latest = next;
          onUpdate?.({
            content: [{ type: "text", text: next.result ?? "Researching…" }],
            details: next,
          });
        },
      });

      return {
        content: [{ type: "text", text: run.result ?? run.error ?? "Research did not return a result." }],
        details: latest ?? run,
        ...(run.status === "error" ? { isError: true } : {}),
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (result, options, theme, context) =>
      renderSubagentResult(researcherProfile, result, options, theme, context),
    renderShell: "self",
  });

  pi.registerTool({
    name: WORKER_TOOL_NAME,
    label: workerProfile.label,
    description: workerProfile.description,
    parameters: Type.Object({ task: Type.String() }),
    executionMode: "parallel",
    async execute(_id, { task }, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      let latest: SubagentRun | undefined;
      const run = await runWorker({
        task,
        cwd: ctx.cwd,
        ...(signal ? { signal } : {}),
        onUpdate: (next) => {
          latest = next;
          onUpdate?.({
            content: [{ type: "text", text: next.result ?? "Working…" }],
            details: next,
          });
        },
      });

      return {
        content: [{ type: "text", text: run.result ?? run.error ?? "Worker did not return a result." }],
        details: latest ?? run,
        ...(run.status === "error" ? { isError: true } : {}),
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (result, options, theme, context) =>
      renderSubagentResult(workerProfile, result, options, theme, context),
    renderShell: "self",
  });
}

export { RESEARCHER_TOOL_NAME, researcherProfile, runResearcher } from "./agents/researcher/index.ts";
export { WORKER_TOOL_NAME, workerProfile, runWorker } from "./agents/worker/index.ts";
