import { expandedActivity } from "./activity.ts";
import { padOutput } from "../tools/padding.ts";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { RostrixRuntime, TaskStatus, TaskUsage } from "pi-rostrix";
import type { SubagentRun } from "../../subagents/runtime/types.ts";
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

function toSubagentUsage(usage: TaskUsage | undefined): SubagentRun["usage"] {
  if (!usage) return undefined;
  return {
    input: usage.input,
    output: usage.output,
    ...(usage.cacheRead !== undefined ? { cacheRead: usage.cacheRead } : {}),
    ...(usage.cacheWrite !== undefined ? { cacheWrite: usage.cacheWrite } : {}),
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(usage.totalTokens !== undefined ? { totalTokens: usage.totalTokens } : {}),
    ...(usage.cost
      ? {
          cost: {
            ...(usage.cost.input !== undefined ? { input: usage.cost.input } : {}),
            ...(usage.cost.output !== undefined ? { output: usage.cost.output } : {}),
            ...(usage.cost.cacheRead !== undefined ? { cacheRead: usage.cost.cacheRead } : {}),
            ...(usage.cost.cacheWrite !== undefined ? { cacheWrite: usage.cost.cacheWrite } : {}),
            ...(usage.cost.total !== undefined ? { total: usage.cost.total } : {}),
          },
        }
      : {}),
  };
}

function mapStatus(status: TaskStatus): SubagentRun["status"] {
  switch (status) {
    case "completed":
      return "success";
    case "failed":
      return "error";
    case "aborted":
      return "aborted";
    default:
      return "running";
  }
}

export function renderSubagentResult(
  profile: SubagentRendererProfile,
  result: AgentToolResult<SubagentRun>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
  runtime?: RostrixRuntime,
): Text {
  const details = result.details && !Array.isArray(result.details.items)
    ? { ...result.details, items: [] }
    : result.details;

  const runId = (details as SubagentRun & { runId?: string } | undefined)?.runId;
  const taskRecord = runId && runtime ? runtime.tasks.getTask(runId) : undefined;
  const usage = toSubagentUsage(taskRecord?.usage);
  const taskRun: SubagentRun | undefined = taskRecord
    ? {
        status: mapStatus(taskRecord.status),
        startedAt: taskRecord.startedAt ?? taskRecord.createdAt,
        lastActivityAt: taskRecord.lastActivityAt,
        items: [],
        ...(taskRecord.finishedAt !== undefined ? { finishedAt: taskRecord.finishedAt } : {}),
        ...(taskRecord.result !== undefined ? { result: taskRecord.result } : {}),
        ...(taskRecord.error !== undefined ? { error: taskRecord.error } : {}),
        ...(usage ? { usage } : {}),
      }
    : undefined;
  const primary = context.args?.question ?? context.args?.task ?? context.args?.scope;
  const task = typeof primary === "string"
    ? primary
    : (context.toolCallId ? getSubagentEntry(context.toolCallId)?.task : undefined) ?? (runId ? getSubagentEntry(runId)?.task : undefined);
  const format = (run: SubagentRun | undefined, currentOptions: ToolRenderResultOptions, icon?: string, width = 10000) =>
    currentOptions.expanded
      ? collapsed(run, profile, theme, icon, Date.now(), undefined, false).split("\n")[0] +
        (task ? `\n${task.split("\n").map((line) => theme.fg("muted", line)).join("\n")}` : "") + expandedActivity(run, theme, width) + expandedDetails(run, theme)
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
  const run = taskRun ?? liveEntry?.run ?? (
    !options.isPartial && runId && details?.status === "running"
      ? { ...details, status: "aborted" as const }
      : details
  );
  component.update(run, options, format);
  if (liveToolCallId && run?.status === "running") {
    component.bindLive(liveToolCallId, (listener) => {
      const unsubSubagent = subscribeSubagent(liveToolCallId, listener);
      if (runtime && runId) {
        const unsubTask = runtime.tasks.subscribe(runId, (record) => {
          const u = toSubagentUsage(record.usage);
          listener({
            status: mapStatus(record.status),
            startedAt: record.startedAt ?? record.createdAt,
            lastActivityAt: record.lastActivityAt,
            items: [],
            ...(record.finishedAt !== undefined ? { finishedAt: record.finishedAt } : {}),
            ...(record.result !== undefined ? { result: record.result } : {}),
            ...(record.error !== undefined ? { error: record.error } : {}),
            ...(u ? { usage: u } : {}),
          });
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
