import assert from "node:assert/strict";
import { test } from "node:test";
import type { SubagentEvent } from "./events.ts";
import { MAX_RETAINED_ITEMS, MAX_RETAINED_TEXT_CHARS } from "./limits.ts";
import { reduceSubagentEvent } from "./state.ts";
import type { SubagentRun } from "./types.ts";

function mixedRun(count: number): SubagentRun {
  let run: SubagentRun = { status: "running", startedAt: 0, items: [] };
  for (let i = 0; i < count; i++) {
    run = reduceSubagentEvent(run, i % 2 === 0
      ? { type: "thinking", text: String(i), contentIndex: i }
      : { type: "tool_start", id: String(i), name: "tool" });
  }
  return run;
}

for (const count of [MAX_RETAINED_ITEMS - 1, MAX_RETAINED_ITEMS, MAX_RETAINED_ITEMS + 1]) {
  test(`mixed activity retains the rolling cap at ${count} items`, () => {
    const run = mixedRun(count);
    assert.equal(run.items.length, Math.min(count, MAX_RETAINED_ITEMS));
    assert.equal(run.itemsTruncated, count > MAX_RETAINED_ITEMS ? true : undefined);
    assert.deepEqual(run.items, mixedRun(MAX_RETAINED_ITEMS).items.slice(count > MAX_RETAINED_ITEMS ? 1 : 0, count)
      .concat(count > MAX_RETAINED_ITEMS ? [{ kind: "thinking", text: String(count - 1), contentIndex: count - 1 }] : []));
  });
}

const updates: { name: string; event: SubagentEvent }[] = [
  { name: "tool arguments", event: { type: "tool_start", id: "199", name: "bash", args: { command: "pwd" } } },
  { name: "tool completion", event: { type: "tool_end", id: "199", isError: false, result: "done" } },
  { name: "missing tool completion", event: { type: "tool_end", id: "missing", isError: false, result: "done" } },
  { name: "thinking replacement", event: { type: "thinking", contentIndex: 198, text: "updated" } },
  { name: "long thinking replacement", event: { type: "thinking", contentIndex: 198, text: "x".repeat(MAX_RETAINED_TEXT_CHARS + 1) } },
  { name: "long final text", event: { type: "result", text: "x".repeat(MAX_RETAINED_TEXT_CHARS + 1) } },
  { name: "usage", event: { type: "usage", usage: { input: 1, output: 2 } } },
  { name: "model error", event: { type: "model_error", message: "error" } },
  { name: "diagnostic", event: { type: "diagnostic", message: "ignored" } },
];

for (const truncated of [false, true]) {
  for (const { name, event } of updates) {
    test(`${name} ${truncated ? "preserves truncation" : "does not falsely mark truncation"}`, () => {
      const run = mixedRun(MAX_RETAINED_ITEMS + Number(truncated));
      const before = structuredClone(run);
      const next = reduceSubagentEvent(run, event);
      assert.equal(next.itemsTruncated, truncated ? true : undefined);
      assert.equal(next.items.length, MAX_RETAINED_ITEMS);
      assert.deepEqual(run, before);
    });
  }
}
