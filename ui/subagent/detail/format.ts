import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentItem, SubagentRun } from "../../../subagents/runtime/types.ts";
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
): string[] {
  const lines: string[] = [];
  const agentLabel = titleCase(
    entry.profile.label || entry.profile.id || "Subagent",
  );

  // 1. Header: Agent label
  lines.push(theme.bold(theme.fg("toolTitle", agentLabel)));

  // 2. Task summary
  const taskClean = cleanPlainText(entry.task) || entry.task;
  const wrappedTask = wrapTextWithAnsi(`Task: ${taskClean}`, innerWidth);
  for (const tLine of wrappedTask) {
    lines.push(theme.fg("text", tLine));
  }

  // 3. Status line
  const { run } = entry;
  const elapsed = Math.max(0, (run.finishedAt ?? now) - run.startedAt);
  const dur = formatDuration(elapsed);
  const idle = idleDuration(run, now);
  const usageStr = formatUsage(run.usage);
  const usageSuffix = usageStr ? ` · ${usageStr}` : "";

  if (run.status === "running") {
    if (idle >= STALLED_THRESHOLD_MS) {
      lines.push(
        theme.fg("muted", `Running${usageSuffix} · ${dur} · No activity for ${formatDuration(idle)}`),
      );
    } else {
      lines.push(theme.fg("muted", `Running${usageSuffix} · ${dur}`));
    }
  } else if (run.status === "success") {
    lines.push(
      theme.fg("toolOutput", "✓ Complete") + theme.fg("muted", `${usageSuffix} · ${dur}`),
    );
  } else if (run.status === "error") {
    lines.push(
      theme.fg("error", "✗ Failed") + theme.fg("muted", `${usageSuffix} · ${dur}`),
    );
  } else if (run.status === "aborted") {
    lines.push(
      theme.fg("error", "■ Aborted") + theme.fg("muted", `${usageSuffix} · ${dur}`),
    );
  }

  // Header separator
  lines.push(theme.fg("muted", "─".repeat(Math.max(1, Math.min(innerWidth, 40)))));

  // 4. Activity list in chronological order
  for (const item of run.items) {
    if (item.kind === "thinking") {
      const thought = usefulText(item.text);
      if (thought) {
        for (const tLine of thought.split("\n")) {
          const wrapped = wrapTextWithAnsi(tLine, Math.max(10, innerWidth - 4));
          for (let i = 0; i < wrapped.length; i++) {
            const prefix = i === 0 ? "│ ✦ " : "│   ";
            lines.push(theme.fg("thinkingText", `${prefix}${wrapped[i]}`));
          }
        }
      }
      continue;
    }

    if (item.kind === "tool") {
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
      lines.push(theme.fg(color, `│ ${icon} ${provider}`));

      const detail = usefulText(item.result);
      if (detail) {
        for (const dLine of detail.split("\n")) {
          const wrapped = wrapTextWithAnsi(dLine, Math.max(10, innerWidth - 4));
          for (const wLine of wrapped) {
            lines.push(theme.fg(color, `│   ${wLine}`));
          }
        }
      }
    }
  }

  // Stalled indication during running
  if (run.status === "running" && idle >= STALLED_THRESHOLD_MS) {
    lines.push(theme.fg("muted", `│ No activity for ${formatDuration(idle)}`));
  }

  // 5. Final result / error block
  if (run.status !== "running" || run.result || run.error) {
    if (run.error) {
      lines.push(theme.bold(theme.fg("error", "╰ Error")));
      const errText =
        usefulText(run.error) ||
        (run.status === "aborted" ? "Subagent aborted" : "Subagent failed");
      for (const eLine of errText.split("\n")) {
        const wrapped = wrapTextWithAnsi(eLine, Math.max(10, innerWidth - 4));
        for (const wLine of wrapped) {
          lines.push(theme.fg("error", `   ${wLine}`));
        }
      }
    } else if (run.result) {
      lines.push(theme.bold(theme.fg("text", "╰ Result")));
      const resText = usefulText(run.result);
      for (const rLine of resText.split("\n")) {
        const wrapped = wrapTextWithAnsi(rLine, Math.max(10, innerWidth - 4));
        for (const wLine of wrapped) {
          lines.push(theme.fg("toolOutput", `   ${wLine}`));
        }
      }
    } else if (run.status === "success") {
      lines.push(theme.bold(theme.fg("text", "╰ Result")));
      lines.push(theme.fg("toolOutput", `   ${agentLabel} complete`));
    } else if (run.status === "aborted") {
      lines.push(theme.bold(theme.fg("error", "╰ Error")));
      lines.push(theme.fg("error", `   ${agentLabel} aborted`));
    }
  }

  return lines;
}

export function frameDetailBox(
  contentLines: string[],
  title: string,
  width: number,
  height: number,
  scrollTop: number,
  theme: Theme,
): string[] {
  const boxWidth = Math.max(20, width);
  const boxHeight = Math.max(4, height);
  const innerHeight = Math.max(1, boxHeight - 2);
  const innerWidth = Math.max(1, boxWidth - 4);

  // Top border: ┌─ Title ─────── Esc ─┐
  const escLabel = "Esc ─┐";
  const topPrefix = "┌─ ";
  const titleText = title ? `${title} ` : "";
  const titleWidth = visibleWidth(titleText);
  const prefixWidth = visibleWidth(topPrefix);
  const escWidth = visibleWidth(escLabel);
  const dashesNeeded = boxWidth - prefixWidth - titleWidth - escWidth;

  let topBorder = "";
  if (dashesNeeded >= 0) {
    topBorder =
      theme.fg("muted", topPrefix) +
      theme.bold(theme.fg("toolTitle", titleText)) +
      theme.fg("muted", "─".repeat(dashesNeeded) + escLabel);
  } else {
    const truncatedTitle =
      truncateToWidth(
        title,
        Math.max(1, boxWidth - prefixWidth - escWidth - 2),
        "…",
      ) + " ";
    const remDashes = Math.max(
      0,
      boxWidth - prefixWidth - visibleWidth(truncatedTitle) - escWidth,
    );
    topBorder =
      theme.fg("muted", topPrefix) +
      theme.bold(theme.fg("toolTitle", truncatedTitle)) +
      theme.fg("muted", "─".repeat(remDashes) + escLabel);
  }

  // Bottom border with scroll indicator if scrollable
  const isScrollable = contentLines.length > innerHeight;
  let bottomBorder = "";
  if (isScrollable) {
    const startNum = Math.min(contentLines.length, scrollTop + 1);
    const endNum = Math.min(contentLines.length, scrollTop + innerHeight);
    const scrollIndicator = ` [${startNum}-${endNum}/${contentLines.length}] ─┘`;
    const botPrefix = "└─";
    const botDashes = Math.max(
      0,
      boxWidth - visibleWidth(botPrefix) - visibleWidth(scrollIndicator),
    );
    bottomBorder = theme.fg(
      "muted",
      botPrefix + "─".repeat(botDashes) + scrollIndicator,
    );
  } else {
    bottomBorder = theme.fg(
      "muted",
      "└" + "─".repeat(Math.max(0, boxWidth - 2)) + "┘",
    );
  }

  // Content slice
  const maxScroll = Math.max(0, contentLines.length - innerHeight);
  const clampedScroll = Math.max(0, Math.min(scrollTop, maxScroll));
  const resultLines: string[] = [topBorder];

  for (let i = 0; i < innerHeight; i++) {
    const rawLine = contentLines[clampedScroll + i] ?? "";
    const visLen = visibleWidth(rawLine);
    let lineContent = rawLine;
    if (visLen > innerWidth) {
      lineContent = truncateToWidth(rawLine, innerWidth);
    }
    const currentVis = visibleWidth(lineContent);
    const padding = " ".repeat(Math.max(0, innerWidth - currentVis));
    resultLines.push(
      theme.fg("muted", "│ ") + lineContent + padding + theme.fg("muted", " │"),
    );
  }

  resultLines.push(bottomBorder);
  return resultLines;
}
