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

test("task headers and expanded results follow render options", (t) => {
  for (const { expanded, status, error } of [
    { expanded: false, status: "success", error: undefined },
    { expanded: true, status: "success", error: undefined },
    { expanded: true, status: "error", error: "Run failed" },
  ] as const) {
    const run: SubagentRun = {
      status, ...(error ? { error } : {}), startedAt: 0, finishedAt: 1000,
      items: [{ kind: "tool", name: "read", status: "success", result: "Tool detail" }],
      result: "Final detail",
    };
    const component = renderSubagentResult(researcherProfile,
      { content: [], details: run }, { isPartial: false, expanded }, theme,
      { args: { question: "Inspect\n files" }, invalidate: () => {} });
    t.after(() => (component as SubagentResultComponent).dispose());
    const output = rendered(component);
    assert.match(output, expanded ? /Agent\(researcher\)/ : /Agent\(researcher: Inspect files\)/);
    assert.equal(output.includes("Tool detail"), false);
    assert.equal(output.includes("Final detail"), expanded);
    if (expanded) {
      assert.ok(!output.includes("question:"));
      assert.ok(!output.includes("Result:"));
      assert.match(output, /files\s*\n\s*\n\s*Final detail/);
    }
    assert.equal(output.includes("Run failed"), Boolean(error));
  }
});

test("expanded task and answer use distinct theme roles", (t) => {
  const colors: Array<{ color: string; text: string }> = [];
  const previewTheme: Theme = {
    fg: (color, text) => { colors.push({ color, text }); return text; },
    bold: (text) => text,
  };
  const component = renderSubagentResult(researcherProfile,
    { content: [], details: { status: "success", startedAt: 0, items: [], result: "Unique answer" } },
    { expanded: true, isPartial: false }, previewTheme,
    { args: { task: "Unique request" }, invalidate() {} });
  t.after(() => (component as SubagentResultComponent).dispose());
  const output = rendered(component);
  assert.ok(colors.some(({ color, text }) => color === "muted" && text === "Unique request"));
  assert.ok(colors.some(({ color, text }) => color === "text" && text === "Unique answer"));
  assert.equal(output.split("Unique answer").length - 1, 1);
});

test("expanded arguments and answer wrap completely with inner indentation", (t) => {
  for (const key of ["question", "task", "scope"]) {
    for (const width of [24, 60]) {
      const task = `${"original scope ".repeat(80)}\nTAIL_${key}`;
      const run: SubagentRun = { status: "success", startedAt: 1, items: [{ kind: "thinking", text: "PRIVATE_ACTIVITY" }], result: `${"returned answer ".repeat(30)}\nANSWER_TAIL` };
      const component = renderSubagentResult(researcherProfile, { content: [], details: run },
        { isPartial: false, expanded: true }, theme, { args: { [key]: task }, invalidate() {} });
      t.after(() => (component as SubagentResultComponent).dispose());
      const lines = component.render(width);
      const output = lines.join("\n");
      assert.ok(output.includes(`TAIL_${key}`));
      assert.ok(output.includes("ANSWER_TAIL"));
      assert.ok(!output.includes("PRIVATE_ACTIVITY"));
      assert.ok(!output.includes("…"));
      assert.ok(lines.every((line) => line.length <= width));
      assert.ok(lines.slice(1).every((line) => line.startsWith("   ")));
      assert.equal(output.replace(/\s/g, "").includes(task.replace(/\s/g, "")), true);
    }
  }
});
