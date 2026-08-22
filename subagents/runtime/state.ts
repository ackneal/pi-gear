import type { SubagentEvent } from "./events.ts";
import type { SubagentRun } from "./types.ts";
import { MAX_RETAINED_ITEMS, truncateRetainedText } from "./limits.ts";

type Usage = NonNullable<SubagentRun["usage"]>;

function sumOptional(left: number | undefined, right: number | undefined): number | undefined {
  return left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
}

function addUsage(left: Usage | undefined, right: Usage): Usage {
  if (!left) return { ...right, ...(right.cost ? { cost: { ...right.cost } } : {}) };
  const result: Usage = { input: left.input + right.input, output: left.output + right.output };
  for (const key of ["cacheRead", "cacheWrite", "cacheWrite1h", "reasoning", "totalTokens"] as const) {
    const value = sumOptional(left[key], right[key]);
    if (value !== undefined) result[key] = value;
  }
  if (left.cost || right.cost) {
    const cost: NonNullable<Usage["cost"]> = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) {
      const value = sumOptional(left.cost?.[key], right.cost?.[key]);
      if (value !== undefined) cost[key] = value;
    }
    result.cost = cost;
  }
  return result;
}

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
    return {
      ...run,
      lastActivityAt: now,
      usage: addUsage(run.usage, event.usage),
    };
  }

  const items = run.items.map((item) => ({ ...item }));

  if (event.type === "thinking") {
    const text = truncateRetainedText(event.text);
    if (event.contentIndex !== undefined) {
      const existing = items.find(
        (item) => item.kind === "thinking" && item.contentIndex === event.contentIndex && item.messageId === event.messageId,
      );
      if (existing?.kind === "thinking") {
        existing.text = text;
      } else {
        items.push({ kind: "thinking", text, contentIndex: event.contentIndex, ...(event.messageId !== undefined ? { messageId: event.messageId } : {}) });
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
