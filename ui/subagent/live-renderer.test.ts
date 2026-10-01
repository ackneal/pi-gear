import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { researcherProfile } from "../../subagents/agents/researcher/index.ts";
import type { SubagentRun } from "../../subagents/runtime/types.ts";
import { clearSubagentRegistry, formatDetailContent, getSubagentEntry, recordSubagentLiveStart, recordSubagentLiveUpdate } from "./detail/index.ts";
import { SubagentResultComponent } from "./component.ts";
import { renderSubagentResult } from "./renderer.ts";
import type { Theme } from "./format.ts";

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

function rendered(component: { render(width: number): string[] }): string {
  return component.render(100).join("\n");
}

test("asynchronous transcript component follows live registry updates through completion", () => {
  clearSubagentRegistry();
  const initial: SubagentRun = { status: "running", startedAt: Date.now(), items: [] };
  recordSubagentLiveStart("async-call", researcherProfile, "Inspect", initial);
  let invalidations = 0;

  const component = renderSubagentResult(
    researcherProfile,
    { content: [{ type: "text", text: "started" }], details: { ...initial, runId: "run-1" } } as AgentToolResult<SubagentRun>,
    { isPartial: false, expanded: false } as never,
    theme,
    { toolCallId: "async-call", args: { question: "Inspect" }, invalidate: () => { invalidations++; } },
  );
  assert.match(rendered(component), /Researching/);

  recordSubagentLiveUpdate("async-call", {
    ...initial,
    items: [{ kind: "tool", id: "read-1", name: "read", status: "running" }],
  });
  assert.match(rendered(component), /Read running/);
  assert.equal(invalidations, 1);

  recordSubagentLiveUpdate("async-call", {
    ...initial,
    status: "success",
    finishedAt: Date.now(),
    result: "Done",
    items: [{ kind: "tool", id: "read-1", name: "read", status: "success" }],
  });
  assert.match(rendered(component), /Research complete/);
  assert.equal(invalidations, 2);
  assert.ok(component instanceof SubagentResultComponent);
  component.dispose();
});

const historyCases = [
  { name: "missing items", fields: {}, expectedItems: [] },
  { name: "undefined items", fields: { items: undefined }, expectedItems: [] },
  { name: "null items", fields: { items: null }, expectedItems: [] },
  { name: "empty items", fields: { items: [] }, expectedItems: [] },
  {
    name: "thinking item",
    fields: { items: [{ kind: "thinking", text: "Checking history" }] },
    expectedItems: [{ kind: "thinking", text: "Checking history" }],
  },
];

for (const { name, fields, expectedItems } of historyCases) {
  test(`history hydration preserves details and safely formats ${name}`, (t) => {
    clearSubagentRegistry();
    t.after(() => clearSubagentRegistry());
    const details = { status: "success", startedAt: 1, result: "Done", ...fields } as unknown as SubagentRun;
    const originalDetails = structuredClone(details);
    t.after(() => assert.deepEqual(details, originalDetails, "original details must not be mutated"));
    const toolCallId = `history-${name}`;
    const component = renderSubagentResult(
      researcherProfile,
      { content: [{ type: "text", text: "Done" }], details } as AgentToolResult<SubagentRun>,
      { isPartial: false, expanded: false } as never,
      theme,
      { toolCallId, args: { question: "Inspect" }, invalidate: () => {} },
    );
    assert.ok(component instanceof SubagentResultComponent);
    t.after(() => component.dispose());

    const entry = getSubagentEntry(toolCallId);
    assert.ok(entry, "history should be registered");
    assert.doesNotThrow(() => formatDetailContent(entry, theme, 80));
    assert.ok(Array.isArray(entry.run.items), "hydrated items must always be an array");
    assert.deepEqual(entry.run.items, expectedItems);
    assert.deepEqual(details, originalDetails);
  });
}

test("partial transcript rendering remains driven by normal partial results", () => {
  const running: SubagentRun = { status: "running", startedAt: Date.now(), items: [{ kind: "thinking", text: "Checking" }] };
  const component = renderSubagentResult(
    researcherProfile,
    { content: [{ type: "text", text: "Checking" }], details: running } as AgentToolResult<SubagentRun>,
    { isPartial: true, expanded: false } as never,
    theme,
    { toolCallId: "foreground-call", args: { question: "Inspect" }, invalidate: () => {} },
  );

  assert.match(rendered(component), /Checking/);
  assert.ok(component instanceof SubagentResultComponent);
  component.dispose();
});
