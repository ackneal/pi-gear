import type { SubagentEvent } from "./events.ts";
import type { SubagentRun } from "./types.ts";
import { MAX_RETAINED_ITEMS, truncateRetainedText } from "./limits.ts";

const sumOptional = (a?: number, b?: number): number | undefined => {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
};

function mergeUsage(
  current: SubagentRun["usage"],
  next: NonNullable<SubagentRun["usage"]>,
): NonNullable<SubagentRun["usage"]> {
  const input = (current?.input ?? 0) + (next.input ?? 0);
  const output = (current?.output ?? 0) + (next.output ?? 0);
  const cacheRead = sumOptional(current?.cacheRead, next.cacheRead);
  const cacheWrite = sumOptional(current?.cacheWrite, next.cacheWrite);
  const totalTokens = sumOptional(current?.totalTokens, next.totalTokens);

  const costTotal = sumOptional(current?.cost?.total, next.cost?.total);
  const costInput = sumOptional(current?.cost?.input, next.cost?.input);
  const costOutput = sumOptional(current?.cost?.output, next.cost?.output);
  const costCacheRead = sumOptional(current?.cost?.cacheRead, next.cost?.cacheRead);
  const costCacheWrite = sumOptional(current?.cost?.cacheWrite, next.cost?.cacheWrite);

  const hasCost = current?.cost !== undefined || next.cost !== undefined;
  const cost = hasCost
    ? {
        ...(costTotal !== undefined ? { total: costTotal } : {}),
        ...(costInput !== undefined ? { input: costInput } : {}),
        ...(costOutput !== undefined ? { output: costOutput } : {}),
        ...(costCacheRead !== undefined ? { cacheRead: costCacheRead } : {}),
        ...(costCacheWrite !== undefined ? { cacheWrite: costCacheWrite } : {}),
      }
    : undefined;

  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
    ...(cost !== undefined ? { cost } : {}),
  };
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
      usage: mergeUsage(run.usage, event.usage),
    };
  }

  const items = run.items.map((item) => ({ ...item }));

  if (event.type === "thinking") {
    items.push({ kind: "thinking", text: truncateRetainedText(event.text) });
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
