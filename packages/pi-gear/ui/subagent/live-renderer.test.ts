import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { researcherProfile } from "../../subagents/agents/researcher/index.ts";
import type { TaskSnapshot } from "../../subagents/runtime/types.ts";
import { clearSubagentRegistry, getSubagentEntry, recordSubagentLiveStart, recordSubagentLiveUpdate } from "./registry.ts";
import { SubagentResultComponent } from "./component.ts";
import { renderSubagentResult } from "./renderer.ts";
import type { Theme } from "./format.ts";

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

function rendered(component: { render(width: number): string[] }): string {
  return component.render(100).join("\n");
}

test("asynchronous transcript component follows live registry updates through completion", () => {
  clearSubagentRegistry();
  const initial: TaskSnapshot = { status: "running", startedAt: Date.now(), activities: [] };
  recordSubagentLiveStart("async-call", "Inspect", initial);
  let invalidations = 0;

  const component = renderSubagentResult(
    researcherProfile,
    { content: [{ type: "text", text: "started" }], details: { ...initial, runId: "run-1" } } as AgentToolResult<TaskSnapshot>,
    { isPartial: false, expanded: false } as never,
    theme,
    { toolCallId: "async-call", args: { question: "Inspect" }, invalidate: () => { invalidations++; } },
  );
  assert.match(rendered(component), /Researching/);

  recordSubagentLiveUpdate("async-call", {
    ...initial,
    activities: [{ kind: "tool", id: "read-1", name: "read", status: "running" }],
  });
  assert.match(rendered(component), /Read running/);
  assert.equal(invalidations, 1);

  recordSubagentLiveUpdate("async-call", {
    ...initial,
    status: "success",
    finishedAt: Date.now(),
    result: "Done",
    activities: [{ kind: "tool", id: "read-1", name: "read", status: "success" }],
  });
  assert.match(rendered(component), /Research complete/);
  assert.equal(invalidations, 2);
  assert.ok(component instanceof SubagentResultComponent);
  component.dispose();
});

test("asynchronous transcript component tracks live run by runId even when toolCallId is absent in context", () => {
  clearSubagentRegistry();
  const initial: TaskSnapshot = { status: "running", startedAt: Date.now(), activities: [] };
  const runId = "task-uuid-12345";
  recordSubagentLiveStart(runId, "Perform audit", initial);
  let invalidations = 0;

  const component = renderSubagentResult(
    researcherProfile,
    { content: [{ type: "text", text: "started" }], details: { ...initial, runId } } as AgentToolResult<TaskSnapshot>,
    { isPartial: false, expanded: false } as never,
    theme,
    { invalidate: () => { invalidations++; } },
  );
  // Must render running state rather than being prematurely aborted
  assert.match(rendered(component), /Researching/);
  assert.doesNotMatch(rendered(component), /aborted/i);

  recordSubagentLiveUpdate(runId, {
    ...initial,
    status: "success",
    finishedAt: Date.now(),
    result: "Audit complete",
  });
  assert.match(rendered(component), /Research complete/);
  assert.equal(invalidations, 1);
  assert.ok(component instanceof SubagentResultComponent);
  component.dispose();
});

const historyCases = [
  { name: "missing activities", fields: {}, expectedActivities: [] },
  { name: "undefined activities", fields: { activities: undefined }, expectedActivities: [] },
  { name: "null activities", fields: { activities: null }, expectedActivities: [] },
  { name: "empty activities", fields: { activities: [] }, expectedActivities: [] },
  {
    name: "thinking item",
    fields: { activities: [{ kind: "thinking", text: "Checking history" }] },
    expectedActivities: [{ kind: "thinking", text: "Checking history" }],
  },
];

for (const { name, fields } of historyCases) {
  test(`history rendering preserves details and safely formats ${name}`, (t) => {
    clearSubagentRegistry();
    t.after(() => clearSubagentRegistry());
    const details = { status: "success", startedAt: 1, result: "Done", ...fields } as unknown as TaskSnapshot;
    const originalDetails = structuredClone(details);
    t.after(() => assert.deepEqual(details, originalDetails, "original details must not be mutated"));
    const toolCallId = `history-${name}`;
    const component = renderSubagentResult(
      researcherProfile,
      { content: [{ type: "text", text: "Done" }], details } as AgentToolResult<TaskSnapshot>,
      { isPartial: false, expanded: false } as never,
      theme,
      { toolCallId, args: { question: "Inspect" }, invalidate: () => {} },
    );
    assert.ok(component instanceof SubagentResultComponent);
    t.after(() => component.dispose());

    assert.equal(getSubagentEntry(toolCallId), undefined);
    assert.doesNotThrow(() => component.render(80));
    assert.deepEqual(details, originalDetails);
  });
}

test("partial transcript rendering remains driven by normal partial results", () => {
  const running: TaskSnapshot = { status: "running", startedAt: Date.now(), activities: [{ kind: "thinking", text: "Checking" }] };
  const component = renderSubagentResult(
    researcherProfile,
    { content: [{ type: "text", text: "Checking" }], details: running } as AgentToolResult<TaskSnapshot>,
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
    const run: TaskSnapshot = {
      status, ...(error ? { error } : {}), startedAt: 0, finishedAt: 1000,
      activities: [{ kind: "tool", name: "read", status: "success", result: "Tool detail" }],
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
      assert.match(output, /files[\s\S]*Execution history[\s\S]*Read · success\s*\n\s*\n\s*Final detail/);
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
    { content: [], details: { status: "success", startedAt: 0, activities: [], result: "Unique answer" } },
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
      const run: TaskSnapshot = { status: "success", startedAt: 1, activities: [{ kind: "thinking", text: "PRIVATE_ACTIVITY" }], result: `${"returned answer ".repeat(30)}\nANSWER_TAIL` };
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

test("cleared running history reports unavailable status without inventing an abort", (t) => {
  clearSubagentRegistry();
  t.after(clearSubagentRegistry);
  const details = {
    runId: "old-run", status: "running", startedAt: 1,
    activities: [{ kind: "tool", name: "read", status: "running" }],
  } as TaskSnapshot & { runId: string };
  const result = { content: [], details } as AgentToolResult<TaskSnapshot>;
  const original = structuredClone(result);
  recordSubagentLiveStart("history", "Inspect", details);
  clearSubagentRegistry();
  let invalidations = 0;
  const component = renderSubagentResult(researcherProfile, result,
    { isPartial: false, expanded: true }, theme,
    { toolCallId: "history", args: { task: "Inspect" }, invalidate() { invalidations++; } });
  t.after(() => (component as SubagentResultComponent).dispose());
  assert.match(rendered(component), /Status unavailable/);
  assert.doesNotMatch(rendered(component), /Research aborted/);
  assert.match(rendered(component), /Read · unknown/);
  assert.equal(getSubagentEntry("history"), undefined);
  recordSubagentLiveUpdate("history", { ...details, status: "success" });
  assert.equal(getSubagentEntry("history"), undefined);
  // A new explicit start must not notify a historical view.
  recordSubagentLiveStart("history", "New task", details);
  recordSubagentLiveUpdate("history", { ...details, status: "success" });
  assert.equal(invalidations, 0);
  assert.match(rendered(component), /Read · unknown/);
  assert.deepEqual(result, original);
});

test("renderSubagentResult queries TaskController directly from runtime when available", (t) => {
  clearSubagentRegistry();
  t.after(clearSubagentRegistry);

  const mockRuntime = {
    tasks: {
      getTask: (id: string) => {
        if (id === "task-runtime-1") {
          return {
            taskId: "task-runtime-1",
            status: "completed" as const,
            createdAt: 1000,
            startedAt: 1000,
            finishedAt: 2000,
            lastActivityAt: 2000,
            result: "Authoritative result from runtime TaskController",
            activities: [],
          };
        }
        return undefined;
      },
    },
  } as never;

  const result = {
    content: [{ type: "text", text: "started" }],
    details: { status: "running", startedAt: 1000, activities: [], runId: "task-runtime-1" },
  } as AgentToolResult<TaskSnapshot>;

  const component = renderSubagentResult(
    researcherProfile,
    result,
    { isPartial: false, expanded: true } as never,
    theme,
    { args: { question: "Inspect architecture" }, invalidate: () => {} },
    mockRuntime,
  );
  t.after(() => (component as SubagentResultComponent).dispose());

  const output = rendered(component);
  assert.match(output, /● Agent\(researcher\)/);
  assert.match(output, /Authoritative result from runtime TaskController/);
  assert.doesNotMatch(output, /aborted/i);

  // Test collapsed mode
  const collapsedComponent = renderSubagentResult(
    researcherProfile,
    result,
    { isPartial: false, expanded: false } as never,
    theme,
    { args: { question: "Inspect architecture" }, invalidate: () => {} },
    mockRuntime,
  );
  t.after(() => (collapsedComponent as SubagentResultComponent).dispose());
  const collapsedOutput = rendered(collapsedComponent);
  assert.match(collapsedOutput, /Research complete/);
  assert.match(collapsedOutput, /● Agent\(researcher/);
});

test("renderSubagentResult updates live from TaskController even when UI registry was cleared", (t) => {
  clearSubagentRegistry();
  t.after(clearSubagentRegistry);

  let taskListener: ((task: any) => void) | undefined;
  const mockTask = {
    taskId: "task-live-cleared",
    activities: [],
    status: "running" as const,
    createdAt: 1000,
    startedAt: 1000,
    lastActivityAt: 1000,
  };

  const mockRuntime = {
    tasks: {
      getTask: (id: string) => (id === "task-live-cleared" ? mockTask : undefined),
      subscribe: (id: string, listener: (task: any) => void) => {
        if (id === "task-live-cleared") {
          taskListener = listener;
          return () => { taskListener = undefined; };
        }
        return () => {};
      },
    },
  } as never;

  let invalidations = 0;
  const result = {
    content: [{ type: "text", text: "started" }],
    details: { status: "running", startedAt: 1000, activities: [], runId: "task-live-cleared" },
  } as AgentToolResult<TaskSnapshot>;

  const component = renderSubagentResult(
    researcherProfile,
    result,
    { isPartial: false, expanded: true } as never,
    theme,
    { toolCallId: "call-1", args: { question: "Audit live updates" }, invalidate: () => { invalidations++; } },
    mockRuntime,
  );
  t.after(() => (component as SubagentResultComponent).dispose());

  // UI registry has no entry for call-1, but component is bound to runtime.tasks
  assert.equal(getSubagentEntry("call-1"), undefined);
  assert.ok(taskListener, "taskListener must be registered");

  // When task completes in runtime
  taskListener({
    ...mockTask,
    status: "completed",
    finishedAt: 2500,
    result: "Live update successfully received despite empty UI registry",
  });

  assert.equal(invalidations, 1);
  const updatedOutput = rendered(component);
  assert.match(updatedOutput, /Live update successfully received despite empty UI registry/);
  assert.match(updatedOutput, /● Agent\(researcher\)/);
});

