import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentProfile, SubagentRun } from "../../subagents/runtime/types.ts";
import { SubagentResultComponent } from "./component.ts";
import { recordSubagentStart } from "./detail/index.ts";
import { collapsed, type SubagentRendererProfile, type Theme } from "./format.ts";

type ToolRenderContext = {
  invalidate: () => void;
  lastComponent?: unknown;
  toolCallId?: string;
  args?: { task?: string };
};

import type { Component } from "@earendil-works/pi-tui";

export function renderSubagentCall(_args: { task: string }, _theme: Theme, _context: ToolRenderContext): Component {
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
  if (context.toolCallId && result.details) {
    recordSubagentStart(
      context.toolCallId,
      profile as unknown as SubagentProfile,
      context.args?.task ?? "",
      result.details,
    );
  }

  const format = (run: SubagentRun | undefined, _currentOptions: ToolRenderResultOptions, icon?: string) =>
    collapsed(run, profile, theme, icon);
  const component =
    context.lastComponent instanceof SubagentResultComponent
      ? context.lastComponent
      : new SubagentResultComponent(context.invalidate, format);
  component.update(result.details, options, format);
  return component;
}
