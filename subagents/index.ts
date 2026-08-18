import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  openSubagentDetailOverlay,
  recordSubagentStart,
  recordSubagentUpdate,
} from "../ui/subagent/detail/index.ts";
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
    async execute(toolCallId, { task }, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      const id = toolCallId || `researcher_${Date.now()}`;
      recordSubagentStart(id, researcherProfile, task);
      let latest: SubagentRun | undefined;
      const run = await runResearcher({
        task,
        cwd: ctx.cwd,
        ...(signal ? { signal } : {}),
        onUpdate: (next) => {
          latest = next;
          recordSubagentUpdate(id, next);
          onUpdate?.({
            content: [{ type: "text", text: next.result ?? "Researching…" }],
            details: next,
          });
        },
      });

      recordSubagentUpdate(id, run);

      return {
        content: [{ type: "text", text: run.result ?? run.error ?? "Research did not return a result." }],
        details: latest ?? run,
        ...(run.status === "error" ? { isError: true } : {}),
        ...(run.usage ? { usage: run.usage as any } : {}),
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
    async execute(toolCallId, { task }, signal, onUpdate, ctx): Promise<AgentToolResult<SubagentRun>> {
      const id = toolCallId || `worker_${Date.now()}`;
      recordSubagentStart(id, workerProfile, task);
      let latest: SubagentRun | undefined;
      const run = await runWorker({
        task,
        cwd: ctx.cwd,
        ...(signal ? { signal } : {}),
        onUpdate: (next) => {
          latest = next;
          recordSubagentUpdate(id, next);
          onUpdate?.({
            content: [{ type: "text", text: next.result ?? "Working…" }],
            details: next,
          });
        },
      });

      recordSubagentUpdate(id, run);

      return {
        content: [{ type: "text", text: run.result ?? run.error ?? "Worker did not return a result." }],
        details: latest ?? run,
        ...(run.status === "error" ? { isError: true } : {}),
        ...(run.usage ? { usage: run.usage as any } : {}),
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (result, options, theme, context) =>
      renderSubagentResult(workerProfile, result, options, theme, context),
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

