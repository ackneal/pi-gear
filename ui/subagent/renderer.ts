import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentProfile, SubagentRun } from "../../subagents/runtime/types.ts";
import { SubagentResultComponent } from "./component.ts";
import { getSubagentEntry, hydrateSubagentHistory, subscribeSubagent } from "./detail/index.ts";
import { collapsed, type SubagentRendererProfile, type Theme } from "./format.ts";

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
  if (context.toolCallId && result.details && context.args) {
    const primary = context.args.question ?? context.args.task;
    const task = typeof primary === "string" && primary.trim()
      ? primary
      : JSON.stringify(context.args);
    hydrateSubagentHistory(
      context.toolCallId,
      profile as unknown as SubagentProfile,
      task,
      result.details,
    );
  }

  const format = (run: SubagentRun | undefined, _currentOptions: ToolRenderResultOptions, icon?: string) =>
    collapsed(run, profile, theme, icon);
  const component =
    context.lastComponent instanceof SubagentResultComponent
      ? context.lastComponent
      : new SubagentResultComponent(context.invalidate, format);
  const runId = (result.details as SubagentRun & { runId?: string } | undefined)?.runId;
  const liveToolCallId = runId && context.toolCallId;
  const run = liveToolCallId ? getSubagentEntry(liveToolCallId)?.run ?? result.details : result.details;
  component.update(run, options, format);
  if (liveToolCallId && run?.status === "running") {
    component.bindLive(liveToolCallId, (listener) => subscribeSubagent(liveToolCallId, listener));
  }
  return component;
}
