import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initRostrix, type RostrixRuntime, type TaskRecord, type TaskStatus } from "pi-rostrix";
import { resolve } from "node:path";
import { Type } from "typebox";
import {
  recordSubagentLiveStart,
  recordSubagentLiveUpdate,
} from "../ui/subagent/registry.ts";
import { renderSubagentCall, renderSubagentResult } from "../ui/subagent/renderer.ts";
import {
  formatResearcherInput,
  RESEARCHER_TOOL_NAME,
  researcherParameters,
  researcherProfile,
} from "./agents/researcher/index.ts";
import {
  formatReviewerInput,
  REVIEWER_TOOL_NAME,
  reviewerParameters,
  reviewerProfile,
} from "./agents/reviewer/index.ts";
import {
  formatWorkerInput,
  WORKER_TOOL_NAME,
  workerParameters,
  workerProfile,
} from "./agents/worker/index.ts";
import type { SubagentRun } from "./runtime/types.ts";
import type { WorkspaceServices } from "../workspace/setup.ts";
import { setupSubagentSettings, type SubagentSettings } from "./settings.ts";

export interface SubagentServices {
  settings: SubagentSettings;
}

function mapStatus(status: TaskStatus): SubagentRun["status"] {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "aborted":
      return "aborted";
    case "running":
    case "pending":
    case "blocked":
    default:
      return "running";
  }
}

function recordStart(toolCallId: string | undefined, runId: string, task: string, dispatch?: any): void {
  const initialRun: SubagentRun = {
    status: "running",
    startedAt: Date.now(),
    items: [],
    ...(dispatch ? { dispatch } : {}),
  };
  if (toolCallId) recordSubagentLiveStart(toolCallId, task, initialRun);
  recordSubagentLiveStart(runId, task, initialRun);
}

function recordProgress(toolCallId: string | undefined, runId: string, task: TaskRecord, dispatch?: any): void {
  const run: SubagentRun = {
    status: mapStatus(task.status),
    startedAt: task.startedAt ?? task.createdAt,
    lastActivityAt: task.lastActivityAt,
    items: [],
    ...(task.result !== undefined ? { result: task.result } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(dispatch ? { dispatch } : {}),
  };
  if (toolCallId) recordSubagentLiveUpdate(toolCallId, run);
  recordSubagentLiveUpdate(runId, run);
}

export function setupSubagents(
  pi: ExtensionAPI,
  _workspace?: WorkspaceServices,
  rostrix?: RostrixRuntime,
): SubagentServices {
  const runtime = rostrix ?? initRostrix(pi, { autoRegisterTools: false });
  const settings = setupSubagentSettings(pi);

  // 1. researcher tool -> delegates to gear:researcher profile
  pi.registerTool({
    name: RESEARCHER_TOOL_NAME,
    label: researcherProfile.label,
    description: "Start focused read-only research. Pass the research question as question (optional scope). The researcher inspects the workspace and can search the web (Exa) and GitHub code for external evidence. Returns immediately with a runId; use subagent_observe for progress or completion.",
    parameters: researcherParameters,
    executionMode: "parallel",
    async execute(toolCallId, { question, scope }, signal, _onUpdate, ctx) {
      const task = formatResearcherInput({ question, scope });
      const dispatch = settings.resolve("researcher", ctx);

      const resolved = runtime.resolveProfile("gear:researcher");
      const record = runtime.tasks.spawn({
        profile: resolved,
        task,
        cwd: ctx.cwd,
        model: dispatch.model,
        thinkingLevel: dispatch.thinkingLevel,
        signal,
      });

      recordStart(toolCallId, record.id, task, dispatch);

      runtime.tasks.subscribe(record.id, (updated) => {
        recordProgress(toolCallId, record.id, updated, dispatch);
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: record.id, status: record.status, revision: record.revision }) }],
        details: {
          runId: record.id,
          status: "running" as const,
          startedAt: record.startedAt ?? record.createdAt,
          lastActivityAt: record.lastActivityAt,
          items: [],
          dispatch,
          revision: record.revision,
        },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(researcherProfile, toolResult as any, options, theme, context as any, runtime),
    renderShell: "self",
  });

  // 2. worker tool -> delegates to gear:worker profile
  pi.registerTool({
    name: WORKER_TOOL_NAME,
    label: workerProfile.label,
    description: "Start one bounded task. Pass the work as task, with optional targetFiles, findings, and verification. Returns immediately with a runId; use subagent_observe for progress or completion. Set targetFiles when files may be modified so active scope conflicts can be rejected.",
    parameters: workerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { task: requestedTask, targetFiles, findings, verification }, signal, _onUpdate, ctx) {
      const task = formatWorkerInput({ task: requestedTask, targetFiles, findings, verification });
      const dispatch = settings.resolve("worker", ctx);

      const resolved = runtime.resolveProfile("gear:worker");
      const record = runtime.tasks.spawn({
        profile: resolved,
        task,
        targetFiles: targetFiles?.map((f) => resolve(ctx.cwd, f)),
        cwd: ctx.cwd,
        model: dispatch.model,
        thinkingLevel: dispatch.thinkingLevel,
        signal,
      });

      recordStart(toolCallId, record.id, task, dispatch);

      runtime.tasks.subscribe(record.id, (updated) => {
        recordProgress(toolCallId, record.id, updated, dispatch);
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: record.id, status: record.status, revision: record.revision }) }],
        details: {
          runId: record.id,
          status: "running" as const,
          startedAt: record.startedAt ?? record.createdAt,
          lastActivityAt: record.lastActivityAt,
          items: [],
          dispatch,
          revision: record.revision,
        },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(workerProfile, toolResult as any, options, theme, context as any, runtime),
    renderShell: "self",
  });

  // 3. reviewer tool -> delegates to gear:reviewer profile
  pi.registerTool({
    name: REVIEWER_TOOL_NAME,
    label: reviewerProfile.label,
    description: "Start focused read-only code review. Pass the changes or focus area as scope, with optional context and skills. Returns immediately with a runId; use subagent_observe for progress or completion.",
    parameters: reviewerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { scope, context, skills }, signal, _onUpdate, ctx) {
      const task = formatReviewerInput({ scope, context, skills });
      const dispatch = settings.resolve("reviewer", ctx);

      const resolved = runtime.resolveProfile("gear:reviewer");
      const record = runtime.tasks.spawn({
        profile: resolved,
        task,
        cwd: ctx.cwd,
        model: dispatch.model,
        thinkingLevel: dispatch.thinkingLevel,
        signal,
      });

      recordStart(toolCallId, record.id, task, dispatch);

      runtime.tasks.subscribe(record.id, (updated) => {
        recordProgress(toolCallId, record.id, updated, dispatch);
      });

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: record.id, status: record.status, revision: record.revision }) }],
        details: {
          runId: record.id,
          status: "running" as const,
          startedAt: record.startedAt ?? record.createdAt,
          lastActivityAt: record.lastActivityAt,
          items: [],
          dispatch,
          revision: record.revision,
        },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(reviewerProfile, toolResult as any, options, theme, context as any, runtime),
    renderShell: "self",
  });

  // 4. subagent_observe -> queries rostrix.tasks.wait
  pi.registerTool({
    name: "subagent_observe",
    label: "Observe subagent",
    description: "Wait until the run finishes, goes quiet for a few seconds, or the timeout elapses (default 30s). A timeout ends only this observation; the subagent keeps running. Prefer one long wait over repeated polling; omit afterRevision unless resuming from a known revision.",
    parameters: Type.Object({
      runId: Type.String({ description: "Run identifier returned by researcher, worker, or reviewer." }),
      afterRevision: Type.Optional(Type.Integer({ minimum: 0, description: "Last observed revision. Returns when a newer revision is available." })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Maximum seconds to wait. Defaults to 30; values above 60 are clamped." })),
    }),
    async execute(_toolCallId, { runId, afterRevision, timeoutSeconds }): Promise<any> {
      try {
        const task = await runtime.tasks.wait(runId, {
          ...(afterRevision !== undefined ? { afterRevision } : {}),
          timeoutSeconds: timeoutSeconds ? Math.min(timeoutSeconds, 60) : 30,
        });

        const status = mapStatus(task.status);
        recordProgress(undefined, task.id, task);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                runId: task.id,
                status,
                revision: task.revision,
                result: task.result,
                error: task.error,
              }),
            },
          ],
          details: {
            runId: task.id,
            status,
            revision: task.revision,
            items: [],
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: String(err) }],
          details: { error: String(err), runId, status: "error", revision: 0, items: [] },
        };
      }
    },
    renderCall: () => ({ render: () => [], invalidate: () => {} }),
    renderResult: () => ({ render: () => [], invalidate: () => {} }),
    renderShell: "self",
  });

  // 5. subagent_cancel -> cancels via rostrix.tasks.cancel
  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel subagent",
    description: "Cancel one subagent and wait for its process to terminate. Other runs and the main agent continue; repeated cancellation returns the same terminal state.",
    parameters: Type.Object({ runId: Type.String({ description: "Run identifier returned by researcher, worker, or reviewer." }) }),
    async execute(_toolCallId, { runId }): Promise<any> {
      await runtime.tasks.cancel(runId);
      const task = runtime.tasks.getTask(runId);
      const status = task ? mapStatus(task.status) : "aborted";
      if (task) {
        recordProgress(undefined, runId, task);
      } else {
        recordSubagentLiveUpdate(runId, { status: "aborted", startedAt: Date.now(), items: [] });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              runId,
              status,
            }),
          },
        ],
        details: { runId, status, revision: task?.revision ?? 0, items: [] },
      };
    },
    renderCall: () => ({ render: () => [], invalidate: () => {} }),
    renderResult: () => ({ render: () => [], invalidate: () => {} }),
    renderShell: "self",
  });

  return { settings };
}
