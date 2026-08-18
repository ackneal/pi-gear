import assert from "node:assert/strict";
import test from "node:test";
import { Key } from "@earendil-works/pi-tui";
import { researcherProfile } from "../../../subagents/agents/researcher/index.ts";
import { workerProfile } from "../../../subagents/agents/worker/index.ts";
import type { SubagentRun } from "../../../subagents/runtime/types.ts";
import { collapsed, expanded, type Theme } from "../format.ts";
import { SubagentDetailComponent } from "./component.ts";
import {
  formatDetailContent,
  frameDetailBox,
  STALLED_THRESHOLD_MS,
} from "./format.ts";
import {
  clearSubagentRegistry,
  getAllSubagentEntries,
  getSubagentEntry,
  recordSubagentStart,
  recordSubagentUpdate,
  subscribeSubagent,
  type SubagentViewEntry,
} from "./registry.ts";

const testTheme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test("Test 1: toolCallId resolves correct subagent run from registry", () => {
  clearSubagentRegistry();

  recordSubagentStart("call_101", researcherProfile, "Find memory leaks");
  const entry = getSubagentEntry("call_101");
  assert.ok(entry);
  assert.equal(entry.toolCallId, "call_101");
  assert.equal(entry.task, "Find memory leaks");
  assert.equal(entry.profile.id, researcherProfile.id);
  assert.equal(entry.run.status, "running");
  assert.equal(entry.run.items.length, 0);

  const updatedRun: SubagentRun = {
    status: "success",
    startedAt: 1_000,
    finishedAt: 5_000,
    items: [
      {
        kind: "tool",
        id: "t1",
        name: "mcp__exa__search",
        status: "success",
        result: "No leaks found",
      },
    ],
    result: "Memory audit complete",
  };
  recordSubagentUpdate("call_101", updatedRun);

  const updated = getSubagentEntry("call_101");
  assert.ok(updated);
  assert.equal(updated.run.status, "success");
  assert.equal(updated.run.result, "Memory audit complete");
  assert.equal(updated.run.items.length, 1);
});

test("Test 2: multiple concurrent subagents remain independently addressable", () => {
  clearSubagentRegistry();

  recordSubagentStart("call_r1", researcherProfile, "Research query patterns");
  recordSubagentStart("call_w1", workerProfile, "Execute migration");

  const runR1Update: SubagentRun = {
    status: "running",
    startedAt: 100,
    items: [{ kind: "thinking", text: "Analyzing slow logs" }],
  };
  recordSubagentUpdate("call_r1", runR1Update);

  const entryR1 = getSubagentEntry("call_r1");
  const entryW1 = getSubagentEntry("call_w1");
  assert.ok(entryR1);
  assert.ok(entryW1);

  assert.equal(entryR1.profile.id, "researcher");
  assert.equal(entryR1.run.items.length, 1);
  assert.equal(entryW1.profile.id, "worker");
  assert.equal(entryW1.run.items.length, 0);

  const all = getAllSubagentEntries();
  assert.equal(all.length, 2);
  assert.equal(all[0]?.toolCallId, "call_r1");
  assert.equal(all[1]?.toolCallId, "call_w1");
});

test("Test 3: opening one overlay component displays only that run's content", () => {
  clearSubagentRegistry();

  const entry1: SubagentViewEntry = {
    toolCallId: "call_a",
    task: "Investigate database indexes",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [
        { kind: "thinking", text: "Checking pg_stat_activity" },
        { kind: "tool", name: "mcp__exa__search", status: "success", result: "Exa index tips" },
      ],
    },
    updatedAt: 0,
  };

  const entry2: SubagentViewEntry = {
    toolCallId: "call_b",
    task: "Rewrite auth middleware",
    profile: workerProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [
        { kind: "tool", name: "bash", status: "running" },
      ],
    },
    updatedAt: 0,
  };

  const comp1 = new SubagentDetailComponent({
    entry: entry1,
    theme: testTheme,
    onClose: () => {},
    invalidate: () => {},
    now: () => 1_000,
  });

  const rendered = comp1.render(80).join("\n");
  assert.match(rendered, /Researcher/);
  assert.match(rendered, /Investigate database indexes/);
  assert.match(rendered, /Checking pg_stat_activity/);
  assert.match(rendered, /Exa/);

  assert.doesNotMatch(rendered, /Rewrite auth middleware/);
  assert.doesNotMatch(rendered, /Worker/);
});

test("Test 4: live SubagentRun updates trigger component re-render / update", () => {
  clearSubagentRegistry();

  const entry: SubagentViewEntry = {
    toolCallId: "call_live",
    task: "Live stream monitoring",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
    },
    updatedAt: 0,
  };

  let invalidations = 0;
  const comp = new SubagentDetailComponent({
    entry,
    theme: testTheme,
    onClose: () => {},
    invalidate: () => {
      invalidations += 1;
    },
    now: () => 500,
  });

  comp.render(80);
  assert.equal(invalidations, 0);

  const liveRun: SubagentRun = {
    status: "running",
    startedAt: 0,
    items: [
      {
        kind: "tool",
        name: "mcp__context7__query",
        status: "running",
      },
    ],
  };

  comp.update(liveRun);
  assert.equal(invalidations, 1);

  const updatedRender = comp.render(80).join("\n");
  assert.match(updatedRender, /Context7/);
  assert.match(updatedRender, /● Context7/);
});

test("Test 5: completed, failed, and aborted states format and render correctly", () => {
  const baseEntry: SubagentViewEntry = {
    toolCallId: "call_states",
    task: "State testing",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
    },
    updatedAt: 0,
  };

  // 1. Running active
  const runningLines = formatDetailContent(
    { ...baseEntry, run: { status: "running", startedAt: 0, items: [] } },
    testTheme,
    80,
    5_000,
  ).join("\n");
  assert.match(runningLines, /Running · 5s/);
  assert.doesNotMatch(runningLines, /No activity for/);

  // 2. Running stalled
  const stalledLines = formatDetailContent(
    {
      ...baseEntry,
      run: {
        status: "running",
        startedAt: 0,
        lastActivityAt: 1_000,
        items: [{ kind: "tool", name: "mcp__exa__search", status: "running" }],
      },
    },
    testTheme,
    80,
    1_000 + STALLED_THRESHOLD_MS + 2_000,
  ).join("\n");
  assert.match(stalledLines, /No activity for 17s/);

  // 3. Success
  const successLines = formatDetailContent(
    {
      ...baseEntry,
      run: {
        status: "success",
        startedAt: 0,
        finishedAt: 10_000,
        items: [],
        result: "All queries optimized successfully",
      },
    },
    testTheme,
    80,
    15_000,
  ).join("\n");
  assert.match(successLines, /✓ Complete · 10s/);
  assert.match(successLines, /╰ Result/);
  assert.match(successLines, /All queries optimized successfully/);

  // 4. Failed / Error
  const errorLines = formatDetailContent(
    {
      ...baseEntry,
      run: {
        status: "error",
        startedAt: 0,
        finishedAt: 4_000,
        items: [],
        error: "Network connection refused",
      },
    },
    testTheme,
    80,
    10_000,
  ).join("\n");
  assert.match(errorLines, /✗ Failed · 4s/);
  assert.match(errorLines, /╰ Error/);
  assert.match(errorLines, /Network connection refused/);

  // 5. Aborted
  const abortedLines = formatDetailContent(
    {
      ...baseEntry,
      run: {
        status: "aborted",
        startedAt: 0,
        finishedAt: 3_000,
        items: [],
      },
    },
    testTheme,
    80,
    10_000,
  ).join("\n");
  assert.match(abortedLines, /■ Aborted · 3s/);
  assert.match(abortedLines, /╰ Error/);
  assert.match(abortedLines, /aborted/i);
});

test("Test 6: scrolling (up, down, pageUp, pageDown, home, end, autoScroll)", () => {
  const longItems: SubagentRun["items"] = [];
  for (let i = 1; i <= 60; i++) {
    longItems.push({
      kind: "tool",
      name: `tool_${i}`,
      status: "success",
      result: `Detail line output for item ${i}`,
    });
  }

  const entry: SubagentViewEntry = {
    toolCallId: "call_scroll",
    task: "Long output testing",
    profile: workerProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: longItems,
    },
    updatedAt: 0,
  };

  let invalidates = 0;
  const comp = new SubagentDetailComponent({
    entry,
    theme: testTheme,
    onClose: () => {},
    invalidate: () => {
      invalidates += 1;
    },
    now: () => 1_000,
  });

  // Initial render: autoScroll is true, scrollTop reaches maxScroll
  comp.render(80);
  assert.ok(comp.scrollTop > 0);
  assert.equal(comp.autoScroll, true);

  const maxScroll = comp.scrollTop;

  // Scroll up with 'k' -> autoScroll disabled, scrollTop decreases
  comp.handleInput("k");
  assert.equal(comp.autoScroll, false);
  assert.equal(comp.scrollTop, maxScroll - 1);

  // Scroll to top with 'g' -> autoScroll false, scrollTop = 0
  comp.handleInput("g");
  assert.equal(comp.autoScroll, false);
  assert.equal(comp.scrollTop, 0);

  // Page down with pageDown -> scrollTop advances by page size
  comp.handleInput(Key.pageDown);
  assert.ok(comp.scrollTop > 0);
  const afterPageDown = comp.scrollTop;

  // Page up with pageUp -> scrollTop decreases
  comp.handleInput(Key.pageUp);
  assert.ok(comp.scrollTop < afterPageDown);

  // End with 'G' -> autoScroll = true, scrollTop = maxScroll
  comp.handleInput("G");
  assert.equal(comp.autoScroll, true);
  assert.equal(comp.scrollTop, maxScroll);

  // Down with 'j' at maxScroll -> remains autoScroll = true
  comp.handleInput("j");
  assert.equal(comp.autoScroll, true);
  assert.equal(comp.scrollTop, maxScroll);

  // Mouse wheel up (SGR) -> autoScroll disabled, scrollTop decreases
  comp.handleInput("\x1b[<64;25;12M");
  assert.equal(comp.autoScroll, false);
  assert.ok(comp.scrollTop < maxScroll);

  // Mouse wheel down (SGR) -> scrollTop increases
  const beforeWheelDown = comp.scrollTop;
  comp.handleInput("\x1b[<65;25;12M");
  assert.ok(comp.scrollTop > beforeWheelDown);

  // Mouse clicks are safely absorbed
  comp.handleInput("\x1b[<0;25;12M");
});

test("Test 7: Esc key closes component cleanly without altering runtime state", () => {
  clearSubagentRegistry();

  recordSubagentStart("call_esc", researcherProfile, "Esc test task");
  const entry = getSubagentEntry("call_esc");
  assert.ok(entry);

  let closed = false;
  const comp = new SubagentDetailComponent({
    entry,
    theme: testTheme,
    onClose: () => {
      closed = true;
    },
    invalidate: () => {},
    now: () => 1_000,
  });

  comp.render(80);
  assert.equal(closed, false);

  // Pressing escape triggers onClose
  comp.handleInput(Key.escape);
  assert.equal(closed, true);

  // Registry state remains intact
  const afterClose = getSubagentEntry("call_esc");
  assert.ok(afterClose);
  assert.equal(afterClose.toolCallId, "call_esc");

  // Pressing 'q' also triggers onClose
  let closedQ = false;
  const compQ = new SubagentDetailComponent({
    entry,
    theme: testTheme,
    onClose: () => {
      closedQ = true;
    },
    invalidate: () => {},
  });
  compQ.handleInput("q");
  assert.equal(closedQ, true);
});

test("Test 8: subscription cleanup removes listeners", () => {
  clearSubagentRegistry();

  recordSubagentStart("call_sub", researcherProfile, "Subscription task");

  let calls = 0;
  const unsubscribe = subscribeSubagent("call_sub", () => {
    calls += 1;
  });

  recordSubagentUpdate("call_sub", {
    status: "running",
    startedAt: 0,
    items: [{ kind: "thinking", text: "Thought 1" }],
  });
  assert.equal(calls, 1);

  // Unsubscribe and trigger another update
  unsubscribe();

  recordSubagentUpdate("call_sub", {
    status: "success",
    startedAt: 0,
    finishedAt: 1_000,
    items: [],
    result: "Done",
  });
  assert.equal(calls, 1);
});

test("Test 9: main transcript formatting / rendering remains completely unchanged", () => {
  const run: SubagentRun = {
    status: "success",
    startedAt: 0,
    finishedAt: 1_000,
    items: [
      { kind: "thinking", text: "Thinking: inspect call_secret_123" },
      {
        kind: "tool",
        id: "tool_1",
        name: "mcp__exa__search",
        status: "success",
        result: '{"result":{"summary":"Exa finding"},"toolCallId":"call_hidden"}',
      },
      {
        kind: "tool",
        id: "tool_2",
        name: "mcp__context7__query",
        status: "success",
        result: "Context finding",
      },
    ],
    result: "Final report",
  };

  const collapsedOutput = collapsed(run, researcherProfile, testTheme, "✓", 1_000);
  assert.match(collapsedOutput, /Researcher Task/);
  assert.match(collapsedOutput, /Research complete/);
  assert.match(collapsedOutput, /2 tools · 2 ok · 1s/);

  const expandedOutput = expanded(run, researcherProfile, testTheme, "✓", 1_000);
  assert.match(expandedOutput, /│ ✦ inspect/);
  assert.match(expandedOutput, /│ ✓ Exa/);
  assert.match(expandedOutput, /│   Exa finding/);
  assert.match(expandedOutput, /│ ✓ Context7/);
  assert.match(expandedOutput, /│   Context finding/);
  assert.match(expandedOutput, /╰ Result/);
  assert.match(expandedOutput, /Final report/);
});
