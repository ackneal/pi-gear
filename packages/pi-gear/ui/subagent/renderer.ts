import { normalizeRunActivities } from "../../subagents/activities.ts";
import { expandedActivity } from "./activity.ts";
import { padOutput } from "../tools/padding.ts";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Runtime } from "pi-rostrix";
import { toTaskSnapshot } from "../../subagents/task-snapshot.ts";
import type { TaskViewSnapshot } from "./types.ts";
import { SubagentResultComponent } from "./component.ts";
import { getSubagentEntry, subscribeSubagent } from "./registry.ts";
import { collapsed, expandedDetails, type SubagentDisplayMetadata, type Theme } from "./format.ts";

type ToolRenderContext = {
  invalidate: () => void;
  lastComponent?: unknown;
  toolCallId?: string;
  args?: Record<string, unknown>;
};

import type { Component } from "@earendil-works/pi-tui";

export function renderSubagentCall(_args: Record<string, unknown>, _theme: Theme, _context: ToolRenderContext): Component {
  return {
    render: () => [],
    invalidate: () => {},
  };
}

export function renderSubagentResult(
  metadata: SubagentDisplayMetadata,
  result: AgentToolResult<TaskViewSnapshot>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
  runtime?: Pick<Runtime, "tasks">,
  savedTask?: (taskId: string) => TaskViewSnapshot | undefined,
): Text {
  const details = result.details ? normalizeRunActivities(result.details) : undefined;

  const taskId = (details as TaskViewSnapshot & { taskId?: string } | undefined)?.taskId;
  const taskRecord = taskId && runtime ? runtime.tasks.getTask(taskId) : undefined;
  const runtimeSnapshot = taskRecord ? toTaskSnapshot(taskRecord, details?.modelSelection) : undefined;
  const primary = context.args?.question ?? context.args?.task ?? context.args?.scope;
  const task = typeof primary === "string"
    ? primary
    : (context.toolCallId ? getSubagentEntry(context.toolCallId)?.task : undefined) ?? (taskId ? getSubagentEntry(taskId)?.task : undefined);
  const format = (run: TaskViewSnapshot | undefined, currentOptions: ToolRenderResultOptions, icon?: string, width = 10000) =>
    currentOptions.expanded
      ? collapsed(run, metadata, theme, icon, Date.now(), undefined, run?.status === "unknown") +
        (task ? `\n${task.split("\n").map((line) => theme.fg("muted", line)).join("\n")}` : "") + expandedActivity(run, theme, width) + expandedDetails(run, theme, width)
      : collapsed(run, metadata, theme, icon, Date.now(), task);
  const component =
    context.lastComponent instanceof SubagentResultComponent
      ? context.lastComponent
      : new SubagentResultComponent(context.invalidate, format);
  const liveKey = (context.toolCallId && getSubagentEntry(context.toolCallId))
    ? context.toolCallId
    : (taskId && getSubagentEntry(taskId))
      ? taskId
      : (context.toolCallId ?? taskId);
  const liveEntry = liveKey ? getSubagentEntry(liveKey) : undefined;
  const liveToolCallId = liveKey;
  const run = runtimeSnapshot ?? liveEntry?.run ?? (taskId ? savedTask?.(taskId) : undefined) ?? (
    !options.isPartial && taskId && details?.status === "running"
      ? { ...details, status: "unknown" as const }
      : details
  );
  component.update(run, options, format);
  if (liveToolCallId && run?.status === "running") {
    component.bindLive(liveToolCallId, (listener) => {
      const unsubSubagent = subscribeSubagent(liveToolCallId, listener);
      if (runtime && taskId) {
        const unsubTask = runtime.tasks.subscribe(taskId, (record) => {
          listener(toTaskSnapshot(record, details?.modelSelection));
        });
        return () => {
          unsubSubagent();
          unsubTask();
        };
      }
      return unsubSubagent;
    });
  }
  return padOutput(component);
}
