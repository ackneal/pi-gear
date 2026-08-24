import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  openSubagentDetailOverlay,
  recordSubagentLiveStart,
  recordSubagentLiveUpdate,
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
import { setupSubagentSettings, type SubagentSettings } from "./settings.ts";

export interface SubagentServices {
  settings: SubagentSettings;
  inspect(ctx: ExtensionContext, toolCallId?: string): Promise<void>;
}

export function setupSubagents(pi: ExtensionAPI): SubagentServices {
  const settings = setupSubagentSettings(pi);

  // AgentToolResult has no isError field: a normal return always means success.
  // Flag failed subagent runs through the tool_result hook so Pi records them as errors.
  pi.on("tool_result", (event) => {
    if (
      event.toolName !== RESEARCHER_TOOL_NAME &&
      event.toolName !== WORKER_TOOL_NAME
    ) {
      return;
    }
    const run = event.details as SubagentRun | undefined;
    if (run?.status === "error" || run?.status === "aborted") {
      return { isError: true };
    }
  });

  pi.registerTool({
    name: RESEARCHER_TOOL_NAME,
    label: researcherProfile.label,
    description: researcherProfile.description,
    parameters: researcherParameters,
    executionMode: "parallel",
    async execute(toolCallId, { question, scope }, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      const researcherInput = formatResearcherInput({ question, scope });
      if (toolCallId) {
        recordSubagentLiveStart(toolCallId, researcherProfile, researcherInput);
      }
      const run = await runResearcher(
        researcherInput,
        {
          cwd: ctx.cwd,
          dispatch: settings.resolve("researcher", ctx),
          ...(signal ? { signal } : {}),
          onUpdate: (next) => {
            if (toolCallId) {
              recordSubagentLiveUpdate(toolCallId, next);
            }
            onUpdate?.({
              content: [{ type: "text", text: next.result ?? "Researching…" }],
              details: next,
            });
          },
        },
      );
      const text = run.status === "success"
        ? run.result ?? "Research did not return a result."
        : run.error ?? (run.status === "aborted" ? "Research aborted." : "Research did not complete.");

      return {
        content: [{ type: "text", text }],
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
        recordSubagentLiveStart(toolCallId, workerProfile, workerInput);
      }
      const run = await runWorker(
        workerInput,
        {
          cwd: ctx.cwd,
          dispatch: settings.resolve("worker", ctx),
          ...(signal ? { signal } : {}),
          onUpdate: (next) => {
            if (toolCallId) {
              recordSubagentLiveUpdate(toolCallId, next);
            }
            onUpdate?.({
              content: [{ type: "text", text: next.result ?? "Working…" }],
              details: next,
            });
          },
        },
      );
      const text = run.status === "success"
        ? run.result ?? "Worker did not return a result."
        : run.error ?? (run.status === "aborted" ? "Worker aborted." : "Worker did not complete.");

      return {
        content: [{ type: "text", text }],
        details: run,
        ...(run.usage ? { usage: run.usage as any } : {}),
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (result: AgentToolResult<any>, options, theme, context) =>
      renderSubagentResult(workerProfile, result as AgentToolResult<SubagentRun>, options, theme, context as any),
    renderShell: "self",
  });

  return {
    settings,
    inspect: (ctx, toolCallId) => openSubagentDetailOverlay(ctx, toolCallId),
  };
}
