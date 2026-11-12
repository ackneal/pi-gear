import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskController } from "../tasks/controller.ts";
import type { TaskMonitor } from "../tasks/monitor.ts";
import type { AgentResolver, ResolvedAgentDefinition } from "../agents/resolver.ts";
import type { TaskRecord } from "../tasks/types.ts";
import { resolve } from "node:path";

export interface TaskToolOptions {
  readonly pi: ExtensionAPI;
  readonly taskController: TaskController;
  readonly taskMonitor?: Pick<TaskMonitor, "acknowledgeTask">;
  readonly agentResolver?: AgentResolver | undefined;
  readonly getParentState?: () => {
    readonly agent?: ResolvedAgentDefinition | undefined;
    readonly task?: Pick<TaskRecord, "id" | "depth"> | undefined;
  };
}

export function registerTaskTools(options: TaskToolOptions): void {
  const { pi, taskController } = options;
  const agentResolver = options.agentResolver;
  if (!agentResolver) {
    throw new Error("registerTaskTools requires an agentResolver");
  }

  // 1. delegate tool
  pi.registerTool({
    name: "delegate",
    label: "Delegate Subtask",
    description: "Delegate a subtask to an agent asynchronously in the background. Returns a taskId and the task's wakeOn settings. Enabled events notify the parent via hidden rostrix:subagent_notifications custom messages containing JSON; do not repeatedly wait or poll for independent work with the relevant notifications enabled.",
    parameters: Type.Object({
      agent: Type.String({ description: "ID of the agent to execute the task" }),
      task: Type.String({ description: "The instructions and task prompt for the subagent" }),
      targetFiles: Type.Optional(Type.Array(Type.String(), { description: "Files the subagent is responsible for modifying" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Optional execution timeout in seconds" })),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx): Promise<{ isError?: boolean; content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
      const targetAgentId = params.agent;
      if (!targetAgentId) {
        return {
          isError: true,
          content: [{ type: "text", text: "delegate requires an 'agent' parameter" }],
          details: { missingAgent: true },
        };
      }

      const parent = options.getParentState?.();
      const allowedAgents = parent?.agent?.subagents.allowedAgents;
      if (allowedAgents && !allowedAgents.includes(targetAgentId)) {
        throw new Error(`Agent '${targetAgentId}' is not allowed by the parent agent`);
      }

      const depth = parent?.task ? parent.task.depth + 1 : 0;
      const maxDepth = parent?.agent?.subagents.maxDepth;
      if (maxDepth !== undefined && depth >= maxDepth) {
        throw new Error(`Exceeded parent maximum delegation depth of ${maxDepth}`);
      }

      const resolved = agentResolver.resolve(targetAgentId, {
        activeTools: pi.getActiveTools(),
        ...(allowedAgents !== undefined ? { allowedAgents } : {}),
      });
      const agent = maxDepth === undefined ? resolved : {
        ...resolved,
        subagents: { ...resolved.subagents, maxDepth: Math.min(maxDepth, resolved.subagents.maxDepth) },
      };
      const taskCwd = ctx.cwd;
      const taskRecord = taskController.spawn({
        agent,
        task: params.task,
        targetFiles: params.targetFiles?.map((path) => resolve(taskCwd, path)),
        timeoutSeconds: params.timeoutSeconds,
        cwd: taskCwd,
        depth,
        parentTaskId: parent?.task?.id,
        modelRegistry: ctx.modelRegistry,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              taskId: taskRecord.id,
              status: taskRecord.status,
              agentId: taskRecord.agentId,
              targetFiles: taskRecord.targetFiles,
              wakeOn: taskRecord.wakeOn,
            }, null, 2),
          },
        ],
        details: { taskId: taskRecord.id, wakeOn: taskRecord.wakeOn },
      };
    },
  });

  // 2. task_status tool
  pi.registerTool({
    name: "task_status",
    label: "Task Status",
    description: "Query the status of delegated tasks.",
    parameters: Type.Object({
      taskId: Type.Optional(Type.String({ description: "Specific task ID to query" })),
      agentId: Type.Optional(Type.String({ description: "Filter tasks by agent ID" })),
    }),
    execute: async (_toolCallId, params): Promise<{ isError?: boolean; content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
      if (params.taskId) {
        const task = taskController.getTask(params.taskId);
        if (!task) {
          return {
            isError: true,
            content: [{ type: "text", text: `Task ${params.taskId} not found` }],
            details: { notFound: true, taskId: params.taskId },
          };
        }
        if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
          options.taskMonitor?.acknowledgeTask(task.id);
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: task.id,
                agentId: task.agentId,
                status: task.status,
                revision: task.revision,
                targetFiles: task.targetFiles,
                result: task.result,
                error: task.error,
                usage: task.usage,
              }, null, 2),
            },
          ],
          details: { id: task.id, status: task.status },
        };
      }

      const targetFilter = params.agentId;
      const tasks = taskController.listTasks(targetFilter ? { agentId: targetFilter } : undefined);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              tasks.map((t) => ({
                id: t.id,
                agentId: t.agentId,
                status: t.status,
                revision: t.revision,
                targetFiles: t.targetFiles,
                finishedAt: t.finishedAt,
              })),
              null,
              2,
            ),
          },
        ],
        details: { count: tasks.length },
      };
    },
  });

  // 3. task_wait tool
  pi.registerTool({
    name: "task_wait",
    label: "Wait for Task",
    description: "Optional bounded wait for a task to update or finish. Use when the current step depends on its result, when diagnosing progress, or when the needed event is not enabled in wakeOn. For independent work with relevant notifications enabled, rely on notification instead of repeated waiting or polling.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to wait for" }),
      afterRevision: Type.Optional(Type.Number({ description: "Only return when revision is greater than this" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait before returning current state" })),
    }),
    execute: async (_toolCallId, params): Promise<{ isError?: boolean; content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
      try {
        const task = await taskController.wait(
          params.taskId,
          params.afterRevision !== undefined || params.timeoutSeconds !== undefined
            ? {
                ...(params.afterRevision !== undefined ? { afterRevision: params.afterRevision } : {}),
                ...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}),
              }
            : undefined,
        );

        if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
          options.taskMonitor?.acknowledgeTask(task.id);
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: task.id,
                status: task.status,
                revision: task.revision,
                result: task.result,
                error: task.error,
              }, null, 2),
            },
          ],
          details: { id: task.id, status: task.status, revision: task.revision },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
          details: { error: String(err), taskId: params.taskId },
        };
      }
    },
  });

  // 4. task_cancel tool
  pi.registerTool({
    name: "task_cancel",
    label: "Cancel Task",
    description: "Cancel a running or pending task.",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to cancel" }),
      reason: Type.Optional(Type.String({ description: "Reason for cancellation" })),
    }),
    execute: async (_toolCallId, params) => {
      const ok = await taskController.cancel(params.taskId, params.reason);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ taskId: params.taskId, cancelled: ok }),
          },
        ],
        details: { taskId: params.taskId, cancelled: ok },
      };
    },
  });
}
