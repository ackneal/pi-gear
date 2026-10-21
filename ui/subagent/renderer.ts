import { expandedActivity } from "./activity.ts";
import { padOutput } from "../tools/padding.ts";
import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
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

export function renderSubagentResult(
  profile: SubagentRendererProfile,
  result: AgentToolResult<SubagentRun>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context: ToolRenderContext,
): Text {
  const details = result.details && !Array.isArray(result.details.items)
    ? { ...result.details, items: [] }
    : result.details;

  const primary = context.args?.question ?? context.args?.task ?? context.args?.scope;
  const task = typeof primary === "string" ? primary : context.toolCallId ? getSubagentEntry(context.toolCallId)?.task : undefined;
  const format = (run: SubagentRun | undefined, currentOptions: ToolRenderResultOptions, icon?: string, width = 10000) =>
    currentOptions.expanded
      ? collapsed(run, profile, theme, icon, Date.now(), undefined, false).split("\n")[0] +
        (task ? `\n${task.split("\n").map((line) => theme.fg("muted", line)).join("\n")}` : "") + expandedActivity(run, theme, width) + expandedDetails(run, theme)
      : collapsed(run, profile, theme, icon, Date.now(), task);
  const component =
    context.lastComponent instanceof SubagentResultComponent
      ? context.lastComponent
      : new SubagentResultComponent(context.invalidate, format);
  const runId = (details as SubagentRun & { runId?: string } | undefined)?.runId;
  const liveEntry = runId && context.toolCallId ? getSubagentEntry(context.toolCallId) : undefined;
  const liveToolCallId = liveEntry ? context.toolCallId : undefined;
  const run = liveEntry?.run ?? (
    !options.isPartial && runId && details?.status === "running"
      ? { ...details, status: "aborted" as const }
      : details
  );
  component.update(run, options, format);
  if (liveToolCallId && run?.status === "running") {
    component.bindLive(liveToolCallId, (listener) => subscribeSubagent(liveToolCallId, listener));
  }
  return padOutput(component);
}
