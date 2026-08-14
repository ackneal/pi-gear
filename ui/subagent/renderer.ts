import type { AgentToolResult, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentRun } from "../../subagents/runtime/types.ts";
import { SubagentResultComponent } from "./component.ts";
import { collapsed, expanded, type SubagentRendererProfile, type Theme } from "./format.ts";

type ToolRenderContext = { invalidate: () => void; lastComponent?: unknown };

export function renderSubagentCall(_args: { task: string }, _theme: Theme, _context: ToolRenderContext): Text { return new Text(""); }

export function renderSubagentResult(profile: SubagentRendererProfile, result: AgentToolResult<SubagentRun>, options: ToolRenderResultOptions, theme: Theme, context: ToolRenderContext): Text {
  const format = (run: SubagentRun | undefined, currentOptions: ToolRenderResultOptions, icon?: string) => currentOptions.expanded && run ? expanded(run, profile, theme, icon) : collapsed(run, profile, theme, icon);
  const component = context.lastComponent instanceof SubagentResultComponent ? context.lastComponent : new SubagentResultComponent(context.invalidate, format);
  component.update(result.details, options, format);
  return component;
}
