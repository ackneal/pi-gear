import {
  AssistantMessageComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentItem, SubagentRun } from "../../../subagents/runtime/types.ts";
import { getCustomToolDefinition } from "../../tools/index.ts";
import {
  formatDuration,
  formatUsage,
  idleDuration,
  STALLED_THRESHOLD_MS,
  type Theme,
} from "../format.ts";
import type { SubagentViewEntry } from "./registry.ts";

export { STALLED_THRESHOLD_MS, formatDuration, formatUsage, idleDuration };
export type { Theme };

const INTERNAL_ID = /\b(?:call|toolu|tool|msg|run)_[A-Za-z0-9_-]+\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b/gi;
const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
const USEFUL_JSON_KEYS = new Set([
  "text",
  "content",
  "result",
  "output",
  "message",
  "detail",
  "details",
  "summary",
  "answer",
  "title",
  "snippet",
  "description",
]);

export function titleCase(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function readableProvider(name: string): string {
  const normalized = name.toLowerCase();
  if (/(?:^|__|[_-])exa(?:__|[_-]|$)/.test(normalized)) return "Exa";
  if (/(?:^|__|[_-])context7(?:__|[_-]|$)/.test(normalized)) return "Context7";
  if (
    /(?:^|__|[_-])gh_grep(?:__|[_-]|$)|(?:^|__|[_-])searchgithub(?:__|[_-]|$)/.test(
      normalized,
    )
  )
    return "GitHub grep";
  const parts = name.split(/__|::|\//).filter(Boolean);
  const provider =
    (parts.length > 1 && /^mcp$/i.test(parts[0] ?? "") ? parts[1] : parts[0]) ??
    name;
  return (
    provider
      .replace(/^(?:mcp|tool)[_-]*/i, "")
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool"
  );
}

export function cleanPlainText(value: string): string {
  return value
    .replace(INTERNAL_ID, "")
    .replace(/^\s*thinking:\s*/i, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function stringsFromJson(value: unknown, collected: string[] = []): string[] {
  if (typeof value === "string") {
    const text = cleanPlainText(value);
    if (text) collected.push(text);
    return collected;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringsFromJson(entry, collected);
    return collected;
  }
  if (typeof value !== "object" || value === null) return collected;
  for (const [key, entry] of Object.entries(value)) {
    if (USEFUL_JSON_KEYS.has(key.toLowerCase())) stringsFromJson(entry, collected);
  }
  return collected;
}

export function usefulText(value: string | undefined): string {
  if (!value) return "";
  const candidate = value.trim().match(JSON_FENCE)?.[1] ?? value.trim();
  if (/^[{[]/.test(candidate)) {
    try {
      return [...new Set(stringsFromJson(JSON.parse(candidate)))].join("\n");
    } catch {
      return "";
    }
  }
  return cleanPlainText(value);
}

export function formatDetailContent(
  entry: SubagentViewEntry,
  theme: Theme,
  innerWidth: number,
  now: number = Date.now(),
  toolsExpanded: boolean = false,
): string[] {
  const lines: string[] = [];
  const agentLabel = titleCase(
    entry.profile.label || entry.profile.id || "Subagent",
  );

  // 1. Header: Agent label and status
  const { run } = entry;
  const elapsed = Math.max(0, (run.finishedAt ?? now) - run.startedAt);
  const dur = formatDuration(elapsed);
  const idle = idleDuration(run, now);
  const usageStr = formatUsage(run.usage);
  const usageSuffix = usageStr ? ` · ${usageStr}` : "";

  let statusBadge = "";
  if (run.status === "running") {
    statusBadge =
      idle >= STALLED_THRESHOLD_MS
        ? theme.fg(
            "muted",
            `Running${usageSuffix} · ${dur} · No activity for ${formatDuration(idle)}`,
          )
        : theme.fg("muted", `Running${usageSuffix} · ${dur}`);
  } else if (run.status === "success") {
    statusBadge =
      theme.fg("toolOutput", "✓ Complete") +
      theme.fg("muted", `${usageSuffix} · ${dur}`);
  } else if (run.status === "error") {
    statusBadge =
      theme.fg("error", "✗ Failed") +
      theme.fg("muted", `${usageSuffix} · ${dur}`);
  } else if (run.status === "aborted") {
    statusBadge =
      theme.fg("error", "■ Aborted") +
      theme.fg("muted", `${usageSuffix} · ${dur}`);
  }

  lines.push(
    ` ${theme.bold(theme.fg("accent", agentLabel))} · ${statusBadge}`,
  );

  // 2. Task summary (User message style)
  const taskClean = cleanPlainText(entry.task) || entry.task;
  const wrappedTask = wrapTextWithAnsi(`Task: ${taskClean}`, innerWidth - 2);
  for (const tLine of wrappedTask) {
    lines.push(theme.fg("muted", ` ${tLine}`));
  }

  // 3. Activity list matching Main conversation UI
  for (const item of run.items) {
    if (item.kind === "thinking") {
      const thought = usefulText(item.text);
      if (thought) {
        try {
          const assistantComp = new AssistantMessageComponent(
            { role: "assistant", content: [{ type: "thinking", thinking: thought }] } as unknown as any,
            false,
            undefined,
            "Thinking...",
            1,
          );
          lines.push(...assistantComp.render(innerWidth));
        } catch {
          lines.push(theme.fg("thinkingText", " + Thought"));
          for (const tLine of thought.split("\n")) {
            const wrapped = wrapTextWithAnsi(tLine, Math.max(10, innerWidth - 4));
            for (const wLine of wrapped) {
              lines.push(theme.fg("thinkingText", `   ${wLine}`));
            }
          }
        }
      }
      continue;
    }

    if (item.kind === "tool") {
      try {
        const customDef = getCustomToolDefinition(item.name, process.cwd());
        const toolComp = new ToolExecutionComponent(
          item.name,
          item.id ?? "tool",
          item.args ?? {},
          { showImages: true, imageWidthCells: Math.max(10, innerWidth - 4) },
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
        lines.push(...toolComp.render(innerWidth));
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
  }

  // Stalled indication during running
  if (run.status === "running" && idle >= STALLED_THRESHOLD_MS) {
    lines.push(theme.fg("muted", `   ↳ No activity for ${formatDuration(idle)}`));
  }

  // 4. Final Assistant Response / Error
  if (run.status !== "running" || run.result || run.error) {
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
        lines.push(...assistantComp.render(innerWidth));
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

  return lines;
}

export function frameDetailBox(
  contentLines: string[],
  _title: string,
  width: number,
  height: number,
  scrollTop: number,
  theme: Theme,
  toolsExpanded: boolean = false,
): string[] {
  const panelWidth = Math.max(20, width);
  const borderLine = theme.fg("border", "─".repeat(panelWidth));
  const totalContent = contentLines.length;

  const innerHeight = Math.max(1, height - 3);
  const maxScroll = Math.max(0, totalContent - innerHeight);
  const clampedScroll = Math.max(0, Math.min(scrollTop, maxScroll));

  let scrollInfo = "";
  if (totalContent > innerHeight) {
    const startNum = clampedScroll + 1;
    const endNum = Math.min(totalContent, clampedScroll + innerHeight);
    scrollInfo = `  ${theme.fg("muted", `[${startNum}-${endNum}/${totalContent}]`)}`;
  }

  const expandHint = toolsExpanded ? "collapse tools" : "expand tools";
  const hintLine =
    theme.fg("dim", "esc") +
    theme.fg("muted", " close  ") +
    theme.fg("dim", "ctrl+o") +
    theme.fg("muted", ` ${expandHint}`) +
    scrollInfo;

  const resultLines: string[] = [borderLine];

  for (let i = 0; i < innerHeight; i++) {
    const rawLine = contentLines[clampedScroll + i] ?? "";
    const visLen = visibleWidth(rawLine);
    let lineContent = rawLine;
    if (visLen > panelWidth) {
      lineContent = truncateToWidth(rawLine, panelWidth);
    }
    const padLen = Math.max(0, panelWidth - visibleWidth(lineContent));
    resultLines.push(lineContent + " ".repeat(padLen));
  }

  resultLines.push(borderLine);
  const hintPadLen = Math.max(0, panelWidth - visibleWidth(hintLine));
  resultLines.push(hintLine + " ".repeat(hintPadLen));
  return resultLines;
}
