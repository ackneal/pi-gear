import {
  AssistantMessageComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatSubagentDispatch } from "../../../subagents/runtime/dispatch.ts";
import type { SubagentItem, SubagentRun } from "../../../subagents/runtime/types.ts";
import { getCustomToolDefinition } from "../../tools/index.ts";
import { formatThinking, HIDDEN_THINKING_LABEL } from "../../thinking/index.ts";
import {
  formatDuration,
  formatToolCount,
  formatUsage,
  idleDuration,
  STALLED_THRESHOLD_MS,
  titleCase,
  type Theme,
} from "../format.ts";
import type { SubagentViewEntry } from "./registry.ts";
import { cleanPlainText, readableProvider, usefulText } from "../text-policy.ts";

export { cleanPlainText, usefulText } from "../text-policy.ts";

export { STALLED_THRESHOLD_MS, formatDuration, formatUsage, idleDuration, titleCase };
export type { Theme };

// OSC 133 shell-integration zone markers (\x1b]133;A/B/C/D). The main transcript
// uses them to segment scrollback zones; when overlay content carries them,
// the terminal's shell-integration/transcript feature ingests the wrapped region
// and pollutes the main transcript. Strip them for standalone/overlay rendering.
const OSC133_ZONE_PATTERN = /\x1b\]133;[A-D](?:\x07|\x1b\\)?/g;

export function stripTerminalZoneMarkers(line: string): string {
  return line.replace(OSC133_ZONE_PATTERN, "");
}
export function formatDetailContent(
  entry: SubagentViewEntry,
  theme: Theme,
  innerWidth: number,
  now: number = Date.now(),
  toolsExpanded: boolean = false,
  thinkingExpanded: boolean = true,
  statusText: string = "",
): string[] {
  const lines: string[] = [];
  const agentLabel = titleCase(
    entry.profile.label || entry.profile.id || "Subagent",
  );
  const { run } = entry;
  const idle = idleDuration(run, now);
  // 0. Tools and MCP Capabilities
  const builtins: string[] = [];
  const mcpSpecs: { id: string; tools: readonly { name: string }[] }[] = [];
  for (const c of entry.profile.capabilities) {
    if (c.kind === "builtin") builtins.push(c.name);
    else if (c.kind === "mcp") mcpSpecs.push(c);
  }

  lines.push(theme.fg("accent", theme.bold("[Extension]")));
  lines.push(theme.fg("muted", `  pi-gear/${agentLabel.toLowerCase()}`));
  lines.push("");

  if (builtins.length > 0) {
    lines.push(theme.fg("accent", theme.bold("[Tools]")));
    lines.push(theme.fg("muted", `  ${builtins.join(", ")}`));
    lines.push("");
  }

  if (mcpSpecs.length > 0) {
    lines.push(theme.fg("accent", theme.bold("[MCP]")));
    for (const mcp of mcpSpecs) {
      const toolNames = mcp.tools.map((t) => t.name).join(", ");
      lines.push(theme.fg("muted", `  ${mcp.id}: ${toolNames}`));
    }
    lines.push("");
  }

  // 1. Task prompt (User message style)
  const taskClean = cleanPlainText(entry.task) || entry.task;
  try {
    const userComp = new UserMessageComponent(taskClean);
    lines.push(...userComp.render(innerWidth).map(stripTerminalZoneMarkers));
  } catch {
    const wrappedTask = wrapTextWithAnsi(taskClean, Math.max(10, innerWidth - 2));
    for (const tLine of wrappedTask) {
      lines.push(theme.fg("text", ` ${tLine}`));
    }
  }

  // 2. Activity list matching Main conversation UI
  // Keep uniform vertical spacing between consecutive activity items, like native.
  if (run.items.length > 0) {
    lines.push("");
  }
  let previousWasActivity = false;
  for (const item of run.items) {
    const isActivity = item.kind === "thinking" || item.kind === "tool";
    if (isActivity && previousWasActivity) {
      lines.push("");
    }
    if (item.kind === "thinking") {
      const thought = usefulText(item.text);
      if (thought) {
        if (!thinkingExpanded) {
          // Collapsed: same hidden label as main.
          lines.push(theme.fg("thinkingText", HIDDEN_THINKING_LABEL));
        } else {
          // Expanded: native thinking component, with my ✦ formatter on top.
          const formatted = formatThinking(thought);
          try {
            const assistantComp = new AssistantMessageComponent(
              { role: "assistant", content: [{ type: "thinking", thinking: formatted }] } as unknown as any,
              false,
              undefined,
              "Thinking...",
              1,
            );
            lines.push(...assistantComp.render(innerWidth).map(stripTerminalZoneMarkers));
          } catch {
            for (const tLine of formatted.split("\n")) {
              const wrapped = wrapTextWithAnsi(tLine, Math.max(10, innerWidth - 4));
              for (const wLine of wrapped) {
                lines.push(theme.fg("thinkingText", `  ${wLine}`));
              }
            }
          }
        }
      }
      previousWasActivity = true;
      continue;
    }

    if (item.kind === "tool") {
      try {
        const customDef = getCustomToolDefinition(item.name, process.cwd());
        const toolComp = new ToolExecutionComponent(
          item.name,
          item.id ?? "tool",
          item.args ?? {},
          // No images in the overlay: kitty/iTerm image escapes would be written
          // mid-screen into the terminal stream and leak into the main transcript.
          { showImages: false, imageWidthCells: Math.max(10, innerWidth - 4) },
          customDef,
          { requestRender: () => {} } as unknown as any,
          process.cwd(),
        );
        const isRunning = item.status === "running" && run.status === "running";
        if (!isRunning || item.result) {
          toolComp.updateResult({
            content: [{ type: "text", text: item.result ?? "" }],
            isError: item.status === "error",
          } as unknown as any, isRunning);
        }
        toolComp.setExpanded(toolsExpanded);
        lines.push(...toolComp.render(innerWidth).map(stripTerminalZoneMarkers));
      } catch {
        const icon =
          item.status === "success"
            ? "✓"
            : item.status === "error"
              ? "✗"
              : "●";
        const color =
          item.status === "error"
            ? "error"
            : item.status === "success"
              ? "toolOutput"
              : "muted";
        const provider = readableProvider(item.name);
        lines.push(theme.fg(color, ` ${icon} ${provider}`));

        const detail = usefulText(item.result);
        if (detail && toolsExpanded) {
          const detailLines = detail.split("\n");
          for (let i = 0; i < detailLines.length; i++) {
            const wrapped = wrapTextWithAnsi(
              detailLines[i] ?? "",
              Math.max(10, innerWidth - 6),
            );
            for (let j = 0; j < wrapped.length; j++) {
              const prefix = i === 0 && j === 0 ? "   ↳ " : "     ";
              lines.push(theme.fg("muted", `${prefix}${wrapped[j]}`));
            }
          }
        }
      }
    }
    previousWasActivity = true;
  }

  // Stalled indication during running
  if (run.status === "running" && idle >= STALLED_THRESHOLD_MS) {
    lines.push(theme.fg("muted", `   ↳ No activity for ${formatDuration(idle)}`));
  }

  // 4. Final Assistant Response / Error
  if (run.status !== "running" || run.result || run.error) {
    lines.push("");
    if (run.error) {
      const errText =
        usefulText(run.error) ||
        (run.status === "aborted" ? "Subagent aborted" : "Subagent failed");
      for (const eLine of errText.split("\n")) {
        const wrapped = wrapTextWithAnsi(eLine, Math.max(10, innerWidth - 4));
        for (const wLine of wrapped) {
          lines.push(theme.fg("error", `   ${wLine}`));
        }
      }
    } else if (run.status === "aborted") {
      lines.push(theme.fg("error", `   ${agentLabel} aborted`));
    } else if (run.result) {
      const resText = usefulText(run.result);
      try {
        const assistantComp = new AssistantMessageComponent(
          { role: "assistant", content: [{ type: "text", text: resText }] } as unknown as any,
          false,
          undefined,
          "Thinking...",
          1,
        );
        lines.push(...assistantComp.render(innerWidth).map(stripTerminalZoneMarkers));
      } catch {
        for (const rLine of resText.split("\n")) {
          const wrapped = wrapTextWithAnsi(rLine, Math.max(10, innerWidth - 4));
          for (const wLine of wrapped) {
            lines.push(theme.fg("text", `   ${wLine}`));
          }
        }
      }
    } else if (run.status === "success") {
      lines.push(theme.fg("toolOutput", `   ${agentLabel} complete`));
    }
  }

  // Toggle status line (replaces in place like pi's showStatus), shown after the
  // last content block. No auto-hide; only replaced by the next toggle.
  if (statusText) {
    lines.push("");
    lines.push(theme.fg("dim", statusText));
  }

  // Collapse consecutive blank lines to a single blank so blocks are separated
  // by exactly one gap (native components already add their own leading/trailing
  // spacing, which would otherwise double up with ours).
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line === "" && collapsed[collapsed.length - 1] === "") continue;
    collapsed.push(line);
  }
  return collapsed;
}

export const BOTTOM_SECTION_HEIGHT = 4;

export interface DetailScrollInfo {
  start: number;
  end: number;
  total: number;
}

export function frameDetailBox(
  viewportLines: string[],
  entryOrTitle: SubagentViewEntry | string,
  width: number,
  theme: Theme,
  now: number = Date.now(),
  prevLabel: string = "",
  nextLabel: string = "",
  scroll?: DetailScrollInfo,
): string[] {
  const panelWidth = Math.max(0, width);
  const borderLine = theme.fg("border", "─".repeat(panelWidth));
  const resultLines: string[] = [];

  for (const rawLine of viewportLines) {
    const lineContent = visibleWidth(rawLine) > panelWidth
      ? truncateToWidth(rawLine, panelWidth)
      : rawLine;
    const padLen = Math.max(0, panelWidth - visibleWidth(lineContent));
    resultLines.push(lineContent + " ".repeat(padLen));
  }

  // Key hint box: top border + single hint line + bottom border
  resultLines.push(borderLine);

  const navLeft = prevLabel
    ? theme.fg("dim", "<") + theme.fg("muted", ` ${titleCase(prevLabel)}`)
    : "";
  const navRight = nextLabel
    ? theme.fg("muted", `${titleCase(nextLabel)} `) + theme.fg("dim", ">")
    : "";
  const nav = [navLeft, navRight].filter(Boolean).join(theme.fg("muted", "  "));

  const hintLeft =
    theme.fg("dim", "esc") +
    theme.fg("muted", " close") +
    theme.fg("muted", " │ ") +
    theme.fg("dim", "↑/↓") +
    theme.fg("muted", " scroll") +
    theme.fg("muted", " │ ") +
    theme.fg("dim", "←/→") +
    theme.fg("muted", " switch") +
    theme.fg("muted", " │ ") +
    theme.fg("dim", "g/G") +
    theme.fg("muted", " top/bottom");

  const hintVisLeft = visibleWidth(hintLeft);
  const hintVisNav = nav ? visibleWidth(nav) : 0;
  let hintFormatted: string;
  if (!nav) {
    hintFormatted =
      hintVisLeft > panelWidth
        ? truncateToWidth(hintLeft, panelWidth)
        : hintLeft + " ".repeat(panelWidth - hintVisLeft);
  } else if (hintVisLeft + hintVisNav + 1 <= panelWidth) {
    hintFormatted =
      hintLeft + " ".repeat(panelWidth - hintVisLeft - hintVisNav) + nav;
  } else {
    const combined =
      hintVisLeft + 3 + hintVisNav <= panelWidth
        ? `${hintLeft}   ${nav}`
        : nav;
    const combinedVis = visibleWidth(combined);
    hintFormatted =
      combinedVis > panelWidth
        ? truncateToWidth(combined, panelWidth)
        : combined + " ".repeat(panelWidth - combinedVis);
  }
  resultLines.push(hintFormatted);
  resultLines.push(borderLine);

  // Footer: label/tool-count/scroll left, usage/duration right
  const entry =
    typeof entryOrTitle === "object" && entryOrTitle ? entryOrTitle : undefined;
  const rawLabel =
    typeof entryOrTitle === "string"
      ? entryOrTitle
      : entry?.profile?.label || entry?.profile?.id || "Subagent";
  const agentLabel = titleCase(rawLabel);

  const tools =
    entry?.run?.items.filter(
      (item): item is Extract<SubagentItem, { kind: "tool" }> =>
        item.kind === "tool",
    ) ?? [];
  const toolStr = tools.length ? formatToolCount(tools) : "0 tools";

  const scrollText = scroll && scroll.total > viewportLines.length
    ? `[${scroll.start}-${scroll.end}/${scroll.total}]`
    : "";
  const scrollPart = scrollText ? ` · ${scrollText}` : "";
  const run = entry?.run;
  const dispatch = formatSubagentDispatch(run?.dispatch);
  const dispatchPart = dispatch ? ` · ${dispatch}` : "";
  const leftFooter =
    theme.fg("accent", agentLabel) +
    theme.fg("muted", `${dispatchPart} · ${toolStr}${scrollPart}`);

  const startedAt = run?.startedAt ?? now;
  const finishedAt = run?.finishedAt ?? now;
  const elapsed = Math.max(0, finishedAt - startedAt);
  const durStr = formatDuration(elapsed);
  const usageStr = formatUsage(run?.usage);
  const rightFooterText = usageStr ? `${usageStr} · ${durStr}` : durStr;
  const rightFooter = theme.fg("muted", rightFooterText);

  const leftVis = visibleWidth(leftFooter);
  const rightVis = visibleWidth(rightFooter);
  let footerLine = "";
  if (rightVis > 0) {
    if (leftVis + rightVis + 1 <= panelWidth) {
      const spaceLen = panelWidth - leftVis - rightVis;
      footerLine = leftFooter + " ".repeat(spaceLen) + rightFooter;
    } else if (panelWidth > rightVis + 1) {
      const availLeft = panelWidth - rightVis - 1;
      const truncLeft = truncateToWidth(leftFooter, availLeft);
      const spaceLen = panelWidth - visibleWidth(truncLeft) - rightVis;
      footerLine = truncLeft + " ".repeat(spaceLen) + rightFooter;
    } else {
      footerLine = truncateToWidth(rightFooter, panelWidth);
    }
  } else {
    if (leftVis > panelWidth) {
      footerLine = truncateToWidth(leftFooter, panelWidth);
    } else {
      footerLine = leftFooter + " ".repeat(panelWidth - leftVis);
    }
  }
  resultLines.push(footerLine);

  return resultLines;
}
