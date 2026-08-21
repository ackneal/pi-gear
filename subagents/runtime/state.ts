import type { SubagentEvent } from "./events.ts";
import type { SubagentRun } from "./types.ts";
import { MAX_RETAINED_ITEMS, truncateRetainedText } from "./limits.ts";

function applyToolEnd(
  items: SubagentRun["items"],
  event: Extract<SubagentEvent, { type: "tool_end" }>,
): void {
  const item = items.find((candidate) => candidate.kind === "tool" && candidate.id === event.id);
  if (item?.kind !== "tool") return;

  item.status = event.isError ? "error" : "success";
  if (event.result) item.result = truncateRetainedText(event.result);
}

export function reduceSubagentEvent(
  run: SubagentRun,
  event: SubagentEvent,
  now = Date.now(),
): SubagentRun {
  if (event.type === "diagnostic") {
    return run;
  }

  if (event.type === "usage") {
    // Pi surfaces cumulative usage at multiple lifecycle events; the latest
    // snapshot is the authoritative total, so replace rather than accumulate.
    return {
      ...run,
      lastActivityAt: now,
      usage: event.usage,
    };
  }

  const items = run.items.map((item) => ({ ...item }));

  if (event.type === "thinking") {
    const text = truncateRetainedText(event.text);
    if (event.contentIndex !== undefined) {
      const existing = items.find(
        (item) => item.kind === "thinking" && item.contentIndex === event.contentIndex,
      );
      if (existing?.kind === "thinking") {
        existing.text = text;
      } else {
        items.push({ kind: "thinking", text, contentIndex: event.contentIndex });
      }
    } else {
      const lastItem = items[items.length - 1];
      if (lastItem && lastItem.kind === "thinking") {
        lastItem.text = text;
      } else {
        items.push({ kind: "thinking", text });
      }
    }
  } else if (event.type === "tool_start") {
    const existing = items.find((item) => item.kind === "tool" && item.id === event.id);
    if (existing && existing.kind === "tool") {
      if (event.args && Object.keys(event.args).length > 0) {
        existing.args = event.args;
      }
      if (event.name && existing.name === "tool") {
        existing.name = event.name;
      }
    } else {
      items.push({
        kind: "tool",
        id: event.id,
        name: event.name,
        ...(event.args !== undefined ? { args: event.args } : {}),
        status: "running",
      });
    }
  } else if (event.type === "tool_end") {
    applyToolEnd(items, event);
  }

  const retainedItems = items.slice(-MAX_RETAINED_ITEMS);
  return event.type === "result"
    ? { ...run, lastActivityAt: now, items: retainedItems, result: truncateRetainedText(event.text) }
    : { ...run, lastActivityAt: now, items: retainedItems };
}
