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

  const items = run.items.map((item) => ({ ...item }));

  if (event.type === "thinking") {
    items.push({ kind: "thinking", text: truncateRetainedText(event.text) });
  } else if (
    event.type === "tool_start"
    && !items.some((item) => item.kind === "tool" && item.id === event.id)
  ) {
    items.push({ kind: "tool", id: event.id, name: event.name, status: "running" });
  } else if (event.type === "tool_end") {
    applyToolEnd(items, event);
  }

  const retainedItems = items.slice(-MAX_RETAINED_ITEMS);
  return event.type === "result"
    ? { ...run, lastActivityAt: now, items: retainedItems, result: truncateRetainedText(event.text) }
    : { ...run, lastActivityAt: now, items: retainedItems };
}
