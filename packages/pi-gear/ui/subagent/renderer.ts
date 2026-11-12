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
import { collapsed, expandedDetails, type SubagentRendererProfile, type Theme } from "./format.ts";

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
  profile: SubagentRendererProfile,
  result: AgentToolResult<TaskViewSnapshot>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
  runtime?: Pick<Runtime, "tasks">,
  savedRun?: (runId: string) => TaskViewSnapshot | undefined,
): Text {
  const details = result.details ? normalizeRunActivities(result.details) : undefined;

  const runId = (details as TaskViewSnapshot & { runId?: string } | undefined)?.runId;
  const taskRecord = runId && runtime ? runtime.tasks.getTask(runId) : undefined;
  const runtimeRun = taskRecord ? toTaskSnapshot(taskRecord, details?.dispatch) : undefined;
  const primary = context.args?.question ?? context.args?.task ?? context.args?.scope;
  const task = typeof primary === "string"
    ? primary
    : (context.toolCallId ? getSubagentEntry(context.toolCallId)?.task : undefined) ?? (runId ? getSubagentEntry(runId)?.task : undefined);
  const format = (run: TaskViewSnapshot | undefined, currentOptions: ToolRenderResultOptions, icon?: string, width = 10000) =>
    currentOptions.expanded
      ? collapsed(run, profile, theme, icon, Date.now(), undefined, run?.status === "unknown") +
        (task ? `\n${task.split("\n").map((line) => theme.fg("muted", line)).join("\n")}` : "") + expandedActivity(run, theme, width) + expandedDetails(run, theme, width)
      : collapsed(run, profile, theme, icon, Date.now(), task);
  const component =
    context.lastComponent instanceof SubagentResultComponent
      ? context.lastComponent
      : new SubagentResultComponent(context.invalidate, format);
  const liveKey = (context.toolCallId && getSubagentEntry(context.toolCallId))
    ? context.toolCallId
    : (runId && getSubagentEntry(runId))
      ? runId
      : (context.toolCallId ?? runId);
  const liveEntry = liveKey ? getSubagentEntry(liveKey) : undefined;
  const liveToolCallId = liveKey;
  const run = runtimeRun ?? liveEntry?.run ?? (runId ? savedRun?.(runId) : undefined) ?? (
    !options.isPartial && runId && details?.status === "running"
      ? { ...details, status: "unknown" as const }
      : details
  );
  component.update(run, options, format);
  if (liveToolCallId && run?.status === "running") {
    component.bindLive(liveToolCallId, (listener) => {
      const unsubSubagent = subscribeSubagent(liveToolCallId, listener);
      if (runtime && runId) {
        const unsubTask = runtime.tasks.subscribe(runId, (record) => {
          listener(toTaskSnapshot(record, details?.dispatch));
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
