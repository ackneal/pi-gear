import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { TaskRegistry } from "../runtime/task-registry.ts";
import type { AgentRegistry } from "../core/registry.ts";
import type { AgentResolver } from "../core/resolver.ts";

export interface RegisterToolsOptions {
  readonly pi: ExtensionAPI;
  readonly taskRegistry: TaskRegistry;
  readonly agentRegistry?: AgentRegistry | undefined;
  readonly agentResolver?: AgentResolver | undefined;
  // Aliases for compatibility
  readonly profileRegistry?: AgentRegistry | undefined;
  readonly profileResolver?: AgentResolver | undefined;
  readonly cwd?: string | undefined;
}

export function registerRostrixTools(options: RegisterToolsOptions): void {
  const { pi, taskRegistry, cwd } = options;
  const agentResolver = options.agentResolver ?? options.profileResolver;
  if (!agentResolver) {
    throw new Error("registerRostrixTools requires an agentResolver or profileResolver");
  }

  // 1. delegate tool
  pi.registerTool({
    name: "delegate",
    label: "Delegate Subtask",
    description: "Delegate a subtask to an agent.",
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "ID of the agent to execute the task" })),
      profile: Type.Optional(Type.String({ description: "Alias for agent ID" })),
      task: Type.String({ description: "The instructions and task prompt for the subagent" }),
      targetFiles: Type.Optional(Type.Array(Type.String(), { description: "Files the subagent is responsible for modifying" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Optional execution timeout in seconds" })),
    }),
    execute: async (_toolCallId, params): Promise<{ isError?: boolean; content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
      const targetAgentId = params.agent ?? params.profile;
      if (!targetAgentId) {
        return {
          isError: true,
          content: [{ type: "text", text: "delegate requires either an 'agent' or 'profile' parameter" }],
          details: { missingAgent: true },
        };
      }

      const resolved = agentResolver.resolve(targetAgentId);
      const taskRecord = taskRegistry.spawn({
        agent: resolved,
        task: params.task,
        targetFiles: params.targetFiles,
        timeoutSeconds: params.timeoutSeconds,
        cwd,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              taskId: taskRecord.id,
              status: taskRecord.status,
              agent: taskRecord.agentId,
              profile: taskRecord.profileId,
              targetFiles: taskRecord.targetFiles,
            }, null, 2),
          },
        ],
        details: { taskId: taskRecord.id },
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
      agent: Type.Optional(Type.String({ description: "Filter tasks by agent ID" })),
      profile: Type.Optional(Type.String({ description: "Alias for agent ID filter" })),
    }),
    execute: async (_toolCallId, params): Promise<{ isError?: boolean; content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
      if (params.taskId) {
        const task = taskRegistry.getTask(params.taskId);
        if (!task) {
          return {
            isError: true,
            content: [{ type: "text", text: `Task ${params.taskId} not found` }],
            details: { notFound: true, taskId: params.taskId },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                id: task.id,
                agent: task.agentId,
                profile: task.profileId,
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

      const targetFilter = params.agent ?? params.profile;
      const tasks = taskRegistry.listTasks(targetFilter ? { agentId: targetFilter } : undefined);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              tasks.map((t) => ({
                id: t.id,
                agent: t.agentId,
                profile: t.profileId,
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
    description: "Wait for a task to update or finish (bounded wait).",
    parameters: Type.Object({
      taskId: Type.String({ description: "Task ID to wait for" }),
      afterRevision: Type.Optional(Type.Number({ description: "Only return when revision is greater than this" })),
      timeoutSeconds: Type.Optional(Type.Number({ description: "Max seconds to wait before returning current state" })),
    }),
    execute: async (_toolCallId, params): Promise<{ isError?: boolean; content: { type: "text"; text: string }[]; details: Record<string, unknown> }> => {
      try {
        const task = await taskRegistry.wait(
          params.taskId,
          params.afterRevision !== undefined || params.timeoutSeconds !== undefined
            ? {
                ...(params.afterRevision !== undefined ? { afterRevision: params.afterRevision } : {}),
                ...(params.timeoutSeconds !== undefined ? { timeoutSeconds: params.timeoutSeconds } : {}),
              }
            : undefined,
        );

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
      const ok = await taskRegistry.cancel(params.taskId, params.reason);
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
