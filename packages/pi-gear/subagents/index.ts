import { parseArgs, SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { init, type ResolvedAgentDefinition, type Runtime, type TaskRecord, type TaskStatus } from "pi-rostrix";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import type { ExtensionConfig } from "../config/types.ts";
import type { ModelSelection, TaskSnapshot } from "./runtime/types.ts";
import type { WorkspaceServices } from "../workspace/setup.ts";
import { setupSubagentSettings, SUBAGENTS, type SubagentSettings } from "./settings.ts";
import { toTaskSnapshot } from "./task-snapshot.ts";
import { normalizeRunActivities } from "./activities.ts";
import { setupExtension } from "../index.ts";

export const PI_GEAR_ENTRY_PATH = fileURLToPath(new URL("../index.ts", import.meta.url));

export function resolveSubagentExtensionOptions(
  agent: ResolvedAgentDefinition,
  config?: Pick<ExtensionConfig, "subagents">,
  argv: readonly string[] = process.argv.slice(2),
) {
  const inheritOverride = config?.subagents?.inheritExtensions;
  const effectiveAgent: ResolvedAgentDefinition = inheritOverride === undefined
    ? agent
    : {
        ...agent,
        extensions: Object.freeze({
          paths: agent.extensions?.paths ?? Object.freeze([]),
          exclude: agent.extensions?.exclude ?? Object.freeze([]),
          inherit: inheritOverride,
        }),
      };

  const inherit = effectiveAgent.extensions?.inherit ?? "none";
  const cliExtensions = inherit === "none" ? [] : (parseArgs([...argv]).extensions ?? []);
  const additionalExtensionPaths = [
    ...cliExtensions,
    ...(config?.subagents?.extensionPaths ?? []),
  ];
  const excludeExtensionPaths = [
    PI_GEAR_ENTRY_PATH,
    ...(config?.subagents?.excludeExtensions ?? []),
  ];

  return {
    agent: effectiveAgent,
    ...(additionalExtensionPaths.length > 0 ? { additionalExtensionPaths } : {}),
    excludeExtensionPaths,
  };
}

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

function recordStart(toolCallId: string | undefined, taskId: string, task: string, modelSelection?: ModelSelection): void {
  const initialRun: TaskSnapshot = {
    status: "running",
    startedAt: Date.now(),
    activities: [],
    ...(modelSelection ? { modelSelection } : {}),
  };
  if (toolCallId) recordSubagentLiveStart(toolCallId, task, initialRun);
  recordSubagentLiveStart(taskId, task, initialRun);
}

function recordProgress(toolCallId: string | undefined, taskId: string, task: TaskRecord, modelSelection?: ModelSelection): void {
  const run = toTaskSnapshot(task, modelSelection);
  if (toolCallId) recordSubagentLiveUpdate(toolCallId, run);
  recordSubagentLiveUpdate(taskId, run);
}

const COMPLETION_ENTRY = "gear:subagent-completion";
type TaskDetails = TaskSnapshot & { taskId: string; revision: number };

function observation(details: TaskDetails) {
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
  workspace?: WorkspaceServices,
  providedRuntime?: Runtime,
  config?: ExtensionConfig,
): SubagentServices {
  const runtime = providedRuntime ?? init(pi, { autoRegisterTaskTools: false });
  runtime.addDelegationToolNames(SUBAGENTS);
  const settings = setupSubagentSettings(pi);
  let sessionContext: ExtensionContext | undefined;
  pi.on("session_start", (_event, ctx) => { sessionContext = ctx; });
  pi.on("session_shutdown", () => { sessionContext = undefined; });

  function savedTask(taskId: string, ctx = sessionContext): TaskDetails | undefined {
    const entry = ctx?.sessionManager.getEntries().reverse().find((entry) =>
      entry.type === "custom" && entry.customType === COMPLETION_ENTRY &&
      (entry.data as TaskDetails | undefined)?.taskId === taskId);
    return entry?.type === "custom" ? normalizeRunActivities(entry.data as TaskDetails) : undefined;
  }

  function track(toolCallId: string, record: TaskRecord, modelSelection: ModelSelection, ctx: ExtensionContext): void {
    recordStart(toolCallId, record.id, record.task, modelSelection);
    sessionContext = ctx;
    const sessionId = ctx.sessionManager.getSessionId();
    const sessionFile = ctx.sessionManager.getSessionFile();
    const update = (updated: TaskRecord) => {
      recordProgress(toolCallId, record.id, updated, modelSelection);
      if (mapStatus(updated.status) === "running") return;

      unsubscribe();
      const completion: TaskDetails = {
        ...toTaskSnapshot(updated, modelSelection), taskId: updated.id, revision: updated.revision,
      };
      if (sessionContext?.sessionManager.getSessionId() === sessionId) {
        pi.appendEntry<TaskDetails>(COMPLETION_ENTRY, completion);
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
    description: "Start focused read-only research. Pass the research question as question (optional scope). The researcher inspects the workspace and can search the web (Exa) and GitHub code for external evidence. Returns immediately with a taskId and the task's actual wakeOn notification triggers. For independent work with completion notification enabled, continue other useful work or end the turn. Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling.",
    parameters: researcherParameters,
    executionMode: "parallel",
    async execute(toolCallId, { question, scope }, signal, _onUpdate, ctx) {
      const task = formatResearcherInput({ question, scope });
      const modelSelection = settings.resolve("researcher", ctx);

      const resolved = runtime.resolveAgent("gear:researcher");
      const record = runtime.tasks.spawn({
        extensionFactories: [(childPi) => setupExtension(childPi, { child: true, fffEndpoint: workspace?.endpoint })],
        ...resolveSubagentExtensionOptions(resolved, config),
        task,
        cwd: ctx.cwd,
        model: modelSelection.model,
        thinkingLevel: modelSelection.thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      track(toolCallId, record, modelSelection, ctx);

      return {
        content: [{ type: "text", text: JSON.stringify({ taskId: record.id, status: record.status, revision: record.revision, wakeOn: record.wakeOn }) }],
        details: { ...toTaskSnapshot(record, modelSelection), taskId: record.id, revision: record.revision, wakeOn: record.wakeOn },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(researcherProfile, toolResult as any, options, theme, context as any, runtime, savedTask),
    renderShell: "self",
  });

  // 2. worker tool -> delegates to gear:worker profile
  pi.registerTool({
    name: WORKER_TOOL_NAME,
    label: workerProfile.label,
    description: "Start one bounded task. Pass the work as task, with optional targetFiles, findings, and verification. Returns immediately with a taskId and the task's actual wakeOn notification triggers. For independent work with completion notification enabled, continue other useful work or end the turn. Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling. Set targetFiles when files may be modified so active scope conflicts can be rejected.",
    parameters: workerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { task: requestedTask, targetFiles, findings, verification }, signal, _onUpdate, ctx) {
      const task = formatWorkerInput({ task: requestedTask, targetFiles, findings, verification });
      const modelSelection = settings.resolve("worker", ctx);

      const resolved = runtime.resolveAgent("gear:worker");
      const record = runtime.tasks.spawn({
        extensionFactories: [(childPi) => setupExtension(childPi, { child: true, fffEndpoint: workspace?.endpoint })],
        ...resolveSubagentExtensionOptions(resolved, config),
        task,
        targetFiles: targetFiles?.map((f) => resolve(ctx.cwd, f)),
        cwd: ctx.cwd,
        model: modelSelection.model,
        thinkingLevel: modelSelection.thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      track(toolCallId, record, modelSelection, ctx);

      return {
        content: [{ type: "text", text: JSON.stringify({ taskId: record.id, status: record.status, revision: record.revision, wakeOn: record.wakeOn }) }],
        details: { ...toTaskSnapshot(record, modelSelection), taskId: record.id, revision: record.revision, wakeOn: record.wakeOn },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(workerProfile, toolResult as any, options, theme, context as any, runtime, savedTask),
    renderShell: "self",
  });

  // 3. reviewer tool -> delegates to gear:reviewer profile
  pi.registerTool({
    name: REVIEWER_TOOL_NAME,
    label: reviewerProfile.label,
    description: "Start focused read-only code review. Pass the changes or focus area as scope, with optional context and skills. Returns immediately with a taskId and the task's actual wakeOn notification triggers. For independent work with completion notification enabled, continue other useful work or end the turn. Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling.",
    parameters: reviewerParameters,
    executionMode: "parallel",
    async execute(toolCallId, { scope, context, skills }, signal, _onUpdate, ctx) {
      const task = formatReviewerInput({ scope, context, skills });
      const modelSelection = settings.resolve("reviewer", ctx);

      const resolved = runtime.resolveAgent("gear:reviewer");
      const record = runtime.tasks.spawn({
        extensionFactories: [(childPi) => setupExtension(childPi, { child: true, fffEndpoint: workspace?.endpoint })],
        ...resolveSubagentExtensionOptions(resolved, config),
        task,
        cwd: ctx.cwd,
        model: modelSelection.model,
        thinkingLevel: modelSelection.thinkingLevel,
        modelRegistry: ctx.modelRegistry,
        signal,
      });

      track(toolCallId, record, modelSelection, ctx);

      return {
        content: [{ type: "text", text: JSON.stringify({ taskId: record.id, status: record.status, revision: record.revision, wakeOn: record.wakeOn }) }],
        details: { ...toTaskSnapshot(record, modelSelection), taskId: record.id, revision: record.revision, wakeOn: record.wakeOn },
      };
    },
    renderCall: renderSubagentCall,
    renderResult: (toolResult, options, theme, context) =>
      renderSubagentResult(reviewerProfile, toolResult as any, options, theme, context as any, runtime, savedTask),
    renderShell: "self",
  });

  // 4. subagent_observe -> queries runtime.tasks.wait
  pi.registerTool({
    name: "subagent_observe",
    label: "Observe subagent",
    description: "Observe only for a current-step dependency or diagnosing progress, using bounded waits without polling. For independent work with completion notification enabled in the task's wakeOn, continue other useful work or end the turn. Wait until the run finishes, goes quiet for a few seconds, or the timeout elapses (default 30s). A timeout ends only this observation; the subagent keeps running. Prefer one long wait over repeated polling; omit afterRevision unless resuming from a known revision.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task identifier returned by researcher, worker, or reviewer." }),
      afterRevision: Type.Optional(Type.Integer({ minimum: 0, description: "Last observed revision. Returns when a newer revision is available." })),
      timeoutSeconds: Type.Optional(Type.Number({ minimum: 0, description: "Maximum seconds to wait. Defaults to 30; values above 60 are clamped." })),
    }),
    async execute(_toolCallId, { taskId, afterRevision, timeoutSeconds }, _signal, _onUpdate, ctx) {
      try {
        if (!runtime.tasks.getTask(taskId)) {
          const saved = savedTask(taskId, ctx);
          if (saved) {
            runtime.monitor.acknowledgeTask(taskId);
            return observation(saved);
          }
        }

        const task = await runtime.tasks.wait(taskId, {
          ...(afterRevision !== undefined ? { afterRevision } : {}),
          timeoutSeconds: timeoutSeconds ? Math.min(timeoutSeconds, 60) : 30,
        });

        const status = mapStatus(task.status);
        recordProgress(undefined, task.id, task);

        if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
          runtime.monitor.acknowledgeTask(task.id);
        }

        return observation({ ...toTaskSnapshot(task), taskId: task.id, status, revision: task.revision });
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: String(err) }],
          details: { error: String(err), taskId, status: "error", revision: 0, activities: [] },
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
    parameters: Type.Object({ taskId: Type.String({ description: "Task identifier returned by researcher, worker, or reviewer." }) }),
    async execute(_toolCallId, { taskId }, _signal, _onUpdate, ctx): Promise<any> {
      await runtime.tasks.cancel(taskId);
      const task = runtime.tasks.getTask(taskId);
      if (!task) {
        const saved = savedTask(taskId, ctx);
        if (saved) return observation(saved);
      }

      const status = task ? mapStatus(task.status) : "aborted";
      if (task) {
        recordProgress(undefined, taskId, task);
      } else {
        recordSubagentLiveUpdate(taskId, { status: "aborted", startedAt: Date.now(), activities: [] });
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              taskId,
              status,
            }),
          },
        ],
        details: { taskId, status, revision: task?.revision ?? 0, activities: [] },
      };
    },
    renderCall: () => ({ render: () => [], invalidate: () => {} }),
    renderResult: () => ({ render: () => [], invalidate: () => {} }),
    renderShell: "self",
  });

  return { settings };
}
