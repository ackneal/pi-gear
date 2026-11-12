import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { init, type Runtime, type TaskRecord, type TaskStatus } from "pi-rostrix";
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
import type { ModelSelection, TaskSnapshot } from "./runtime/types.ts";
import type { WorkspaceServices } from "../workspace/setup.ts";
import { setupSubagentSettings, SUBAGENTS, type SubagentSettings } from "./settings.ts";
import { toTaskSnapshot } from "./task-snapshot.ts";
import { normalizeRunActivities } from "./activities.ts";
import { setupExtension } from "../index.ts";

export interface SubagentServices {
  settings: SubagentSettings;
}

function mapStatus(status: TaskStatus): TaskSnapshot["status"] {
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

function recordStart(toolCallId: string | undefined, runId: string, task: string, dispatch?: ModelSelection): void {
  const initialRun: TaskSnapshot = {
    status: "running",
    startedAt: Date.now(),
    activities: [],
    ...(dispatch ? { dispatch } : {}),
  };
  if (toolCallId) recordSubagentLiveStart(toolCallId, task, initialRun);
  recordSubagentLiveStart(runId, task, initialRun);
}

function recordProgress(toolCallId: string | undefined, runId: string, task: TaskRecord, dispatch?: ModelSelection): void {
  const run = toTaskSnapshot(task, dispatch);
  if (toolCallId) recordSubagentLiveUpdate(toolCallId, run);
  recordSubagentLiveUpdate(runId, run);
}

const COMPLETION_ENTRY = "gear:subagent-completion";
type RunDetails = TaskSnapshot & { runId: string; revision: number };

function observation(details: RunDetails) {
  const tools = details.activities.filter((activity) => activity.kind === "tool");
  return {
    content: [{ type: "text" as const, text: JSON.stringify({
      ...details,
      // Keep complete evidence in details, but bound repeated model-facing output.
      activities: tools.slice(-8).map((item) => {
        const args = item.args === undefined ? undefined : JSON.stringify(item.args);
        return {
          ...item,
          ...(args !== undefined && args.length > 2000 ? { args: args.slice(0, 2000), argsTruncated: true } : {}),
          ...(item.result !== undefined ? { result: item.result.slice(0, 2000), resultTruncated: item.result.length > 2000 } : {}),
        };
      }),
      activitiesTruncated: details.activitiesTruncated || tools.length > 8,
    }) }],
    details,
  };
}

export function setupSubagents(
  pi: ExtensionAPI,
  _workspace?: WorkspaceServices,
  providedRuntime?: Runtime,
): SubagentServices {
  const runtime = providedRuntime ?? init(pi, { autoRegisterTaskTools: false });
  runtime.addDelegationToolNames(SUBAGENTS);
  const settings = setupSubagentSettings(pi);
  let sessionContext: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => { sessionContext = ctx; });
  pi.on("session_shutdown", () => { sessionContext = undefined; });

  function savedRun(runId: string, ctx = sessionContext): RunDetails | undefined {
    const entry = ctx?.sessionManager.getEntries().reverse().find((entry) =>
      entry.type === "custom" && entry.customType === COMPLETION_ENTRY &&
      (entry.data as RunDetails | undefined)?.runId === runId);
    return entry?.type === "custom" ? normalizeRunActivities(entry.data as RunDetails) : undefined;
  }

  function track(toolCallId: string, record: TaskRecord, dispatch: ModelSelection, ctx: ExtensionContext): void {
    recordStart(toolCallId, record.id, record.task, dispatch);
    sessionContext = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const update = (updated: TaskRecord) => {
      recordProgress(toolCallId, record.id, updated, dispatch);
      if (mapStatus(updated.status) === "running") return;

      unsubscribe();
      const completion: RunDetails = {
        ...toTaskSnapshot(updated, dispatch), runId: updated.id, revision: updated.revision,
      };
      if (sessionContext?.sessionManager.getSessionId() === sessionId) {
        pi.appendEntry<RunDetails>(COMPLETION_ENTRY, completion);
      } else if (sessionFile) {
        // The old extension context is invalid after switching sessions.
        SessionManager.open(sessionFile).appendCustomEntry(COMPLETION_ENTRY, completion);
      }
    };
    const unsubscribe = runtime.tasks.subscribe(record.id, update);
    update(record);
  }

  // 1. researcher tool -> delegates to gear:researcher profile
  pi.registerTool({
    name: RESEARCHER_TOOL_NAME,
    label: researcherProfile.label,
    description: "Start focused read-only research. Pass the research question as question (optional scope). The researcher inspects the workspace and can search the web (Exa) and GitHub code for external evidence. Returns immediately with a runId and the task's actual wakeOn notification triggers. For independent work with completion notification enabled, continue other useful work or end the turn. Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling.",
    parameters: researcherParameters,
    executionMode: "parallel",
    async execute(toolCallId, { question, scope }, signal, _onUpdate, ctx) {
      const task = formatResearcherInput({ question, scope });
      const dispatch = settings.resolve("researcher", ctx);

      const resolved = runtime.resolveAgent("gear:researcher");
      const record = runtime.tasks.spawn({
        extensionFactories: [(childPi) => setupExtension(childPi, { child: true })],
        profile: resolved,
        task,
        cwd: ctx.cwd,
        model: dispatch.model,
        thinkingLevel: dispatch.thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      track(toolCallId, record, dispatch, ctx);

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: record.id, status: record.status, revision: record.revision, wakeOn: record.wakeOn }) }],
        details: { ...toTaskSnapshot(record, dispatch), runId: record.id, revision: record.revision, wakeOn: record.wakeOn },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(researcherProfile, toolResult as any, options, theme, context as any, runtime, savedRun),
    renderShell: "self",
  });

  // 2. worker tool -> delegates to gear:worker profile
  pi.registerTool({
    name: WORKER_TOOL_NAME,
    label: workerProfile.label,
    description: "Start one bounded task. Pass the work as task, with optional targetFiles, findings, and verification. Returns immediately with a runId and the task's actual wakeOn notification triggers. For independent work with completion notification enabled, continue other useful work or end the turn. Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling. Set targetFiles when files may be modified so active scope conflicts can be rejected.",
    parameters: workerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { task: requestedTask, targetFiles, findings, verification }, signal, _onUpdate, ctx) {
      const task = formatWorkerInput({ task: requestedTask, targetFiles, findings, verification });
      const dispatch = settings.resolve("worker", ctx);

      const resolved = runtime.resolveAgent("gear:worker");
      const record = runtime.tasks.spawn({
        extensionFactories: [(childPi) => setupExtension(childPi, { child: true })],
        profile: resolved,
        task,
        targetFiles: targetFiles?.map((f) => resolve(ctx.cwd, f)),
        cwd: ctx.cwd,
        model: dispatch.model,
        thinkingLevel: dispatch.thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      track(toolCallId, record, dispatch, ctx);

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: record.id, status: record.status, revision: record.revision, wakeOn: record.wakeOn }) }],
        details: { ...toTaskSnapshot(record, dispatch), runId: record.id, revision: record.revision, wakeOn: record.wakeOn },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(workerProfile, toolResult as any, options, theme, context as any, runtime, savedRun),
    renderShell: "self",
  });

  // 3. reviewer tool -> delegates to gear:reviewer profile
  pi.registerTool({
    name: REVIEWER_TOOL_NAME,
    label: reviewerProfile.label,
    description: "Start focused read-only code review. Pass the changes or focus area as scope, with optional context and skills. Returns immediately with a runId and the task's actual wakeOn notification triggers. For independent work with completion notification enabled, continue other useful work or end the turn. Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling.",
    parameters: reviewerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { scope, context, skills }, signal, _onUpdate, ctx) {
      const task = formatReviewerInput({ scope, context, skills });
      const dispatch = settings.resolve("reviewer", ctx);

      const resolved = runtime.resolveAgent("gear:reviewer");
      const record = runtime.tasks.spawn({
        extensionFactories: [(childPi) => setupExtension(childPi, { child: true })],
        profile: resolved,
        task,
        cwd: ctx.cwd,
        model: dispatch.model,
        thinkingLevel: dispatch.thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      track(toolCallId, record, dispatch, ctx);

      return {
        content: [{ type: "text", text: JSON.stringify({ runId: record.id, status: record.status, revision: record.revision, wakeOn: record.wakeOn }) }],
        details: { ...toTaskSnapshot(record, dispatch), runId: record.id, revision: record.revision, wakeOn: record.wakeOn },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(reviewerProfile, toolResult as any, options, theme, context as any, runtime, savedRun),
    renderShell: "self",
  });

  // 4. subagent_observe -> queries runtime.tasks.wait
  pi.registerTool({
    name: "subagent_observe",
    label: "Observe subagent",
    description: "Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling. For independent work with completion notification enabled in the task's wakeOn, continue other useful work or end the turn. Wait until the run finishes, goes quiet for a few seconds, or the timeout elapses (default 30s). A timeout ends only this observation; the subagent keeps running. Prefer one long wait over repeated polling; omit afterRevision unless resuming from a known revision.",
    parameters: Type.Object({
      runId: Type.String({ description: "Run identifier returned by researcher, worker, or reviewer." }),
      afterRevision: Type.Optional(Type.Integer({ minimum: 0, description: "Last observed revision. Returns when a newer revision is available." })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Maximum seconds to wait. Defaults to 30; values above 60 are clamped." })),
    }),
    async execute(_toolCallId, { runId, afterRevision, timeoutSeconds }, _signal, _onUpdate, ctx) {
      try {
        if (!runtime.tasks.getTask(runId)) {
          const saved = savedRun(runId, ctx);
          if (saved) {
            runtime.monitor.acknowledgeTask(runId);
            return observation(saved);
          }
        }

        const task = await runtime.tasks.wait(runId, {
          ...(afterRevision !== undefined ? { afterRevision } : {}),
          timeoutSeconds: timeoutSeconds ? Math.min(timeoutSeconds, 60) : 30,
        });

        const status = mapStatus(task.status);
        recordProgress(undefined, task.id, task);

        if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
          runtime.monitor.acknowledgeTask(task.id);
        }

        return observation({ ...toTaskSnapshot(task), runId: task.id, status, revision: task.revision });
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: String(err) }],
          details: { error: String(err), runId, status: "error", revision: 0, activities: [] },
        };
      }
    },
    renderCall: () => ({ render: () => [], invalidate: () => {} }),
    renderResult: () => ({ render: () => [], invalidate: () => {} }),
    renderShell: "self",
  });

  // 5. subagent_cancel -> cancels via runtime.tasks.cancel
  pi.registerTool({
    name: "subagent_cancel",
    label: "Cancel subagent",
    description: "Cancel one subagent and wait for its child session to shut down. Other tasks and the main agent continue; repeated cancellation returns the same terminal state.",
    parameters: Type.Object({ runId: Type.String({ description: "Run identifier returned by researcher, worker, or reviewer." }) }),
    async execute(_toolCallId, { runId }, _signal, _onUpdate, ctx): Promise<any> {
      await runtime.tasks.cancel(runId);
      const task = runtime.tasks.getTask(runId);
      if (!task) {
        const saved = savedRun(runId, ctx);
        if (saved) return observation(saved);
      }

      const status = task ? mapStatus(task.status) : "aborted";
      if (task) {
        recordProgress(undefined, runId, task);
      } else {
        recordSubagentLiveUpdate(runId, { status: "aborted", startedAt: Date.now(), activities: [] });
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
        details: { runId, status, revision: task?.revision ?? 0, activities: [] },
      };
    },
    renderCall: () => ({ render: () => [], invalidate: () => {} }),
    renderResult: () => ({ render: () => [], invalidate: () => {} }),
    renderShell: "self",
  });

  return { settings };
}
