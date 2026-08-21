import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  openSubagentDetailOverlay,
  recordSubagentStart,
  recordSubagentUpdate,
} from "../ui/subagent/detail/index.ts";
import { renderSubagentCall, renderSubagentResult } from "../ui/subagent/renderer.ts";
import {
  formatResearcherInput,
  RESEARCHER_TOOL_NAME,
  researcherParameters,
  researcherProfile,
  runResearcher,
} from "./agents/researcher/index.ts";
import {
  formatWorkerInput,
  WORKER_TOOL_NAME,
  workerParameters,
  workerProfile,
  runWorker,
} from "./agents/worker/index.ts";
import type { SubagentRun } from "./runtime/types.ts";

export function setupSubagents(pi: ExtensionAPI): void {
  pi.registerTool({
    name: RESEARCHER_TOOL_NAME,
    label: researcherProfile.label,
    description: researcherProfile.description,
    parameters: researcherParameters,
    executionMode: "parallel",
    async execute(toolCallId, { question, scope }, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      const researcherInput = formatResearcherInput({ question, scope });
      if (toolCallId) {
        recordSubagentStart(toolCallId, researcherProfile, researcherInput);
      }
      const run = await runResearcher(
        researcherInput,
        {
          cwd: ctx.cwd,
          ...(signal ? { signal } : {}),
          onUpdate: (next) => {
            if (toolCallId) {
              recordSubagentUpdate(toolCallId, next);
            }
            onUpdate?.({
              content: [{ type: "text", text: next.result ?? "Researching…" }],
              details: next,
            });
          },
        },
      );
      if (run.status !== "success") {
        throw new Error(run.error ?? (run.status === "aborted" ? "Research aborted." : "Research did not complete."));
      }

      return {
        content: [{ type: "text", text: run.result ?? "Research did not return a result." }],
        details: run,
        ...(run.usage ? { usage: run.usage as any } : {}),
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (result: AgentToolResult<any>, options, theme, context) =>
      renderSubagentResult(researcherProfile, result as AgentToolResult<SubagentRun>, options, theme, context as any),
    renderShell: "self",
  });

  pi.registerTool({
    name: WORKER_TOOL_NAME,
    label: workerProfile.label,
    description: workerProfile.description,
    parameters: workerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { task, targetFiles, findings, verification }, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      const workerInput = formatWorkerInput({ task, targetFiles, findings, verification });
      if (toolCallId) {
        recordSubagentStart(toolCallId, workerProfile, workerInput);
      }
      const run = await runWorker(
        workerInput,
        {
          cwd: ctx.cwd,
          ...(signal ? { signal } : {}),
          onUpdate: (next) => {
            if (toolCallId) {
              recordSubagentUpdate(toolCallId, next);
            }
            onUpdate?.({
              content: [{ type: "text", text: next.result ?? "Working…" }],
              details: next,
            });
          },
        },
      );
      if (run.status !== "success") {
        throw new Error(run.error ?? (run.status === "aborted" ? "Worker aborted." : "Worker did not complete."));
      }

      return {
        content: [{ type: "text", text: run.result ?? "Worker did not return a result." }],
        details: run,
        ...(run.usage ? { usage: run.usage as any } : {}),
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (result: AgentToolResult<any>, options, theme, context) =>
      renderSubagentResult(workerProfile, result as AgentToolResult<SubagentRun>, options, theme, context as any),
    renderShell: "self",
  });

  pi.registerCommand("subagent", {
    description: "Inspect subagent detail overlay",
    handler: async (args, ctx) =>
      openSubagentDetailOverlay(ctx, args.trim() || undefined),
  });
}

export { RESEARCHER_TOOL_NAME, researcherProfile, runResearcher } from "./agents/researcher/index.ts";
export { WORKER_TOOL_NAME, workerProfile, runWorker } from "./agents/worker/index.ts";
export { openSubagentDetailOverlay } from "../ui/subagent/detail/index.ts";

