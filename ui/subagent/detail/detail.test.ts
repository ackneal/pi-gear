import assert from "node:assert/strict";
import test from "node:test";
import { Key, visibleWidth } from "@earendil-works/pi-tui";
import { researcherProfile } from "../../../subagents/agents/researcher/index.ts";
import { workerProfile } from "../../../subagents/agents/worker/index.ts";
import { setupLifecycle } from "../../../lifecycle/index.ts";
import type { SubagentRun } from "../../../subagents/runtime/types.ts";
import { collapsed, type Theme } from "../format.ts";
import { getCustomToolDefinition } from "../../tools/index.ts";
import { SubagentDetailComponent } from "./component.ts";
import {
  BOTTOM_SECTION_HEIGHT,
  formatDetailContent,
  frameDetailBox,
  STALLED_THRESHOLD_MS,
  stripTerminalZoneMarkers,
} from "./format.ts";
import {
  clearSubagentRegistry,
  getAllSubagentEntries,
  getSubagentEntry,
  recordSubagentLiveStart,
  recordSubagentLiveUpdate,
  subscribeSubagent,
  type SubagentViewEntry,
} from "./registry.ts";

const testTheme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

test("Test 1: toolCallId resolves correct subagent run from registry", () => {
  clearSubagentRegistry();

  recordSubagentLiveStart("call_101", researcherProfile, "Find memory leaks");
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
  recordSubagentLiveUpdate("call_101", updatedRun);

  const updated = getSubagentEntry("call_101");
  assert.ok(updated);
  assert.equal(updated.run.status, "success");
  assert.equal(updated.run.result, "Memory audit complete");
  assert.equal(updated.run.items.length, 1);
});

test("Test 2: multiple concurrent subagents remain independently addressable", () => {
  clearSubagentRegistry();

  recordSubagentLiveStart("call_r1", researcherProfile, "Research query patterns");
  recordSubagentLiveStart("call_w1", workerProfile, "Execute migration");

  const runR1Update: SubagentRun = {
    status: "running",
    startedAt: 100,
    items: [{ kind: "thinking", text: "Analyzing slow logs" }],
  };
  recordSubagentLiveUpdate("call_r1", runR1Update);

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
  comp1.thinkingExpanded = true;

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
  assert.match(runningLines, /State testing/);
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
  assert.match(successLines, /All queries optimized successfully/);
  assert.doesNotMatch(successLines, /✓ Complete/);

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
  assert.match(errorLines, /Network connection refused/);
  assert.doesNotMatch(errorLines, /✗ Failed/);

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
  assert.match(abortedLines, /aborted/i);
  assert.doesNotMatch(abortedLines, /■ Aborted/);
});

test("Test 6: scrolling (up, down, home, end, autoScroll)", () => {
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

  // Scroll up with Key.up -> scrollTop decreases further
  comp.handleInput(Key.up);
  assert.equal(comp.autoScroll, false);
  assert.equal(comp.scrollTop, maxScroll - 2);

  // 'g' -> top
  comp.handleInput("g");
  assert.equal(comp.autoScroll, false);
  assert.equal(comp.scrollTop, 0);

  // 'G' -> bottom
  comp.handleInput("G");
  assert.equal(comp.autoScroll, true);
  assert.equal(comp.scrollTop, maxScroll);

  // Down with 'j' at maxScroll -> remains autoScroll = true
  comp.handleInput("j");
  assert.equal(comp.autoScroll, true);
  assert.equal(comp.scrollTop, maxScroll);

  // Down with Key.down at maxScroll -> remains autoScroll = true
  comp.handleInput(Key.down);
  assert.equal(comp.autoScroll, true);
  assert.equal(comp.scrollTop, maxScroll);
});

test("Test 7: Esc key closes component cleanly without altering runtime state", () => {
  clearSubagentRegistry();

  recordSubagentLiveStart("call_esc", researcherProfile, "Esc test task");
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

  recordSubagentLiveStart("call_sub", researcherProfile, "Subscription task");

  let calls = 0;
  const unsubscribe = subscribeSubagent("call_sub", () => {
    calls += 1;
  });

  recordSubagentLiveUpdate("call_sub", {
    status: "running",
    startedAt: 0,
    items: [{ kind: "thinking", text: "Thought 1" }],
  });
  assert.equal(calls, 1);

  // Unsubscribe and trigger another update
  unsubscribe();

  recordSubagentLiveUpdate("call_sub", {
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
  assert.match(collapsedOutput, /2\/2 tools · 1s/);
});

test("Test 10: detail view formats content cleanly without redundant header and renders task prompt directly", () => {
  const baseEntry: SubagentViewEntry = {
    toolCallId: "call_usage",
    task: "Usage detail task",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
      usage: {
        input: 1_200,
        output: 450,
        cost: { total: 0.002 },
      },
    },
    updatedAt: 0,
  };

  const runningLines = formatDetailContent(
    baseEntry,
    testTheme,
    80,
    5_000,
  ).join("\n");
  assert.match(runningLines, /Usage detail task/);
  assert.doesNotMatch(runningLines, /^Task:/m);
  assert.doesNotMatch(runningLines, /Running ·/);

  const completedLines = formatDetailContent(
    {
      ...baseEntry,
      run: {
        ...baseEntry.run,
        status: "success",
        finishedAt: 10_000,
        result: "Done",
      },
    },
    testTheme,
    80,
    15_000,
  ).join("\n");
  assert.match(completedLines, /Usage detail task/);
  assert.match(completedLines, /Done/);
  assert.doesNotMatch(completedLines, /✓ Complete/);
});

test("Test 10.5: detail output carries no OSC133 zone markers (no transcript pollution)", () => {
  assert.equal(stripTerminalZoneMarkers("\x1b]133;A\x07hi\x1b]133;B\x07\x1b]133;C\x07"), "hi");

  const entry: SubagentViewEntry = {
    toolCallId: "call_pollution",
    task: "Pollution task",
    profile: researcherProfile,
    run: {
      status: "success",
      startedAt: 0,
      finishedAt: 1_000,
      items: [{ kind: "thinking", text: "Thinking: some reasoning" }],
      result: "Final answer",
    },
    updatedAt: 0,
  };
  const output = formatDetailContent(entry, testTheme, 80, 5_000).join("\n");
  assert.doesNotMatch(output, /\x1b\]133;/);
  assert.match(output, /Pollution task/);
  assert.match(output, /Final answer/);
});

test("Test 11: subagent registry is cleared on lifecycle events", () => {
  clearSubagentRegistry();
  recordSubagentLiveStart("call_live", researcherProfile, "Live task");
  assert.equal(getAllSubagentEntries().length, 1);

  const handlers: Record<string, () => void> = {};
  const mockPi = {
    on: (event: string, handler: () => void) => {
      handlers[event] = handler;
    },
  };
  setupLifecycle(mockPi as any);

  // Trigger session_start
  handlers.session_start?.();
  assert.equal(getAllSubagentEntries().length, 0);

  // Add entry and trigger session_before_switch
  recordSubagentLiveStart("call_live2", researcherProfile, "Live task 2");
  assert.equal(getAllSubagentEntries().length, 1);
  handlers.session_before_switch?.();
  assert.equal(getAllSubagentEntries().length, 0);

  // Add entry and trigger session_shutdown
  recordSubagentLiveStart("call_live3", researcherProfile, "Live task 3");
  assert.equal(getAllSubagentEntries().length, 1);
  handlers.session_shutdown?.();
  assert.equal(getAllSubagentEntries().length, 0);
});

test("Test 12: registry ignores missing or empty toolCallId without creating fallback IDs", () => {
  clearSubagentRegistry();

  recordSubagentLiveStart("", researcherProfile, "Missing ID");
  assert.equal(getAllSubagentEntries().length, 0);
  assert.equal(getSubagentEntry(""), undefined);

  recordSubagentLiveUpdate("", {
    status: "running",
    startedAt: 0,
    items: [],
  });
  assert.equal(getAllSubagentEntries().length, 0);

  const unsubscribe = subscribeSubagent("", () => {});
  assert.doesNotThrow(() => unsubscribe());
  assert.equal(getAllSubagentEntries().length, 0);
});

test("Test 13: Key Hint Box renders framed with top/bottom borders and correct shortcut lines", () => {
  const entry: SubagentViewEntry = {
    toolCallId: "call_hint",
    task: "Hint box testing",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
    },
    updatedAt: 0,
  };

  const linesCollapsed = frameDetailBox(
    ["line 1", "line 2"],
    entry,
    120,
    10,
    0,
    testTheme,
        1_000,
  );

  // Height is 10 lines: innerHeight = 6, bottomSection = 4
  assert.equal(linesCollapsed.length, 10);

  // Top border of Key Hint Box is at index 6 (0..5 are content lines)
  const border = "─".repeat(120);
  assert.equal(linesCollapsed[6]?.trim(), border);

  // Single hint line (collapsed)
  assert.match(
    linesCollapsed[7] ?? "",
    /esc close │ ↑\/↓ scroll │ ←\/→ switch │ g\/G top\/bottom/,
  );

  // Bottom border of Key Hint Box is at index 8
  assert.equal(linesCollapsed[8]?.trim(), border);

  // Expanded tools toggle changes hint line to collapse tools
  const linesExpanded = frameDetailBox(
    ["line 1"],
    entry,
    120,
    10,
    0,
    testTheme,
        1_000,
  );
  assert.match(
    linesExpanded[7] ?? "",
    /esc close │ ↑\/↓ scroll │ ←\/→ switch │ g\/G top\/bottom/,
  );
});

test("frameDetailBox respects widths below 20 cells", () => {
  for (const width of [1, 8, 19]) {
    const lines = frameDetailBox(["content wider than the panel"], "researcher", width, 6, 0, testTheme);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
  }
});

test("Test 14: Single Footer line renders subagent label, tool counts, scroll info, and duration", () => {
  const entryNoTools: SubagentViewEntry = {
    toolCallId: "call_f1_notools",
    task: "Footer no tools",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
    },
    updatedAt: 0,
  };

  const linesNoTools = frameDetailBox(
    ["line 1"],
    entryNoTools,
    120,
    10,
    0,
    testTheme,
        1_000,
  );
  // Footer is index 9 (index 6 border, 7 hint, 8 border, 9 footer)
  assert.match(linesNoTools[9] ?? "", /^Researcher · 0 tools/);
  assert.match(linesNoTools[9] ?? "", /1s$/);
  // Not scrollable -> no scroll info
  assert.doesNotMatch(linesNoTools[9] ?? "", /\[\d+-\d+\/\d+\]/);

  // With tools (completed and failed) and scrollable content
  const entryWithTools: SubagentViewEntry = {
    toolCallId: "call_f1_tools",
    task: "Footer tools",
    profile: workerProfile,
    run: {
      status: "running",
      startedAt: 0,
      dispatch: { model: "openai-codex/gpt-5.6-sol", thinkingLevel: "low" },
      items: [
        { kind: "tool", name: "tool1", status: "success" },
        { kind: "tool", name: "tool2", status: "success" },
        { kind: "tool", name: "tool3", status: "error" },
      ],
    },
    updatedAt: 0,
  };

  const longContent = Array.from({ length: 20 }, (_, i) => `content line ${i + 1}`);
  const linesWithTools = frameDetailBox(
    longContent,
    entryWithTools,
    120,
    10,
    2,
    testTheme,
        1_000,
  );

  assert.match(
    linesWithTools[9] ?? "",
    /^Worker · \(openai-codex\) gpt-5\.6-sol • low · 2\/3 tools · 1 failed · \[3-8\/20\]/,
  );
  assert.match(linesWithTools[9] ?? "", /1s$/);
});

test("Test 15: Single Footer line renders usage stats and duration when usage is present", () => {
  const entryWithUsage: SubagentViewEntry = {
    toolCallId: "call_f2_usage",
    task: "Footer usage",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
      usage: {
        input: 13_200,
        output: 613,
        cost: { total: 0.002 },
      },
    },
    updatedAt: 0,
  };

  const linesWithUsage = frameDetailBox(
    ["line 1"],
    entryWithUsage,
    120,
    10,
    0,
    testTheme,
        4_900,
  );
  // Footer is index 9
  assert.match(linesWithUsage[9] ?? "", /^Researcher · 0 tools/);
  assert.match(linesWithUsage[9] ?? "", /↑13k ↓613 · \$0\.002 · 4.9s$/);

  const entryNoUsage: SubagentViewEntry = {
    toolCallId: "call_f2_nousage",
    task: "Footer no usage",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
    },
    updatedAt: 0,
  };

  const linesNoUsage = frameDetailBox(
    ["line 1"],
    entryNoUsage,
    120,
    10,
    0,
    testTheme,
    5_000,
  );
  assert.match(linesNoUsage[9] ?? "", /^Researcher · 0 tools/);
  assert.match(linesNoUsage[9] ?? "", /5s$/);
  assert.doesNotMatch(linesNoUsage[9] ?? "", /↑/);
});

test("Test 16: SubagentDetailComponent innerHeight accounts for BOTTOM_SECTION_HEIGHT (4 lines)", () => {
  const entry: SubagentViewEntry = {
    toolCallId: "call_comp_height",
    task: "Component height check",
    profile: researcherProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [],
    },
    updatedAt: 0,
  };

  const comp = new SubagentDetailComponent({
    entry,
    theme: testTheme,
    onClose: () => {},
    invalidate: () => {},
    now: () => 1_000,
  });

  const rendered = comp.render(120);
  assert.equal(rendered.length, 24);
  assert.equal(BOTTOM_SECTION_HEIGHT, 4);

  // Toggle tools expanded via Ctrl+O
  comp.handleInput("\x0f");
  assert.equal(comp.toolsExpanded, true);
  const renderedExpanded = comp.render(120);
  assert.equal(comp.toolsExpanded, true);
});

test("Test 21: Ctrl+O / Ctrl+T set a status line that replaces in place (like pi showStatus)", () => {
  const entry: SubagentViewEntry = {
    toolCallId: "call_status",
    task: "Task",
    profile: workerProfile,
    run: { status: "success", startedAt: 0, finishedAt: 5, items: [] },
    updatedAt: 0,
  };

  const comp = new SubagentDetailComponent({
    entry,
    theme: testTheme,
    onClose: () => {},
    invalidate: () => {},
    now: () => 1_000,
  });

  // Ctrl+T toggles thinking -> status reflects visible, then hidden (default collapsed)
  comp.handleInput("\x14");
  assert.equal(comp.thinkingExpanded, true);
  assert.equal(comp.statusText, "Thinking blocks: visible");
  comp.handleInput("\x14");
  assert.equal(comp.statusText, "Thinking blocks: hidden");

  // Ctrl+O toggles tools -> status reflects tool output
  comp.handleInput("\x0f");
  assert.equal(comp.toolsExpanded, true);
  assert.equal(comp.statusText, "Tool output: expanded");

  // Status is rendered (dim line) after content
  const out = comp.render(80);
  assert.ok(out.some((l) => l.includes("Tool output: expanded")), "status rendered");
});

test("Test 22: left/right navigate between subagent windows (re-subscribing)", () => {
  const e1: SubagentViewEntry = { toolCallId: "a", task: "t1", profile: workerProfile, run: { status: "running", startedAt: 0, items: [] }, updatedAt: 0 };
  const e2: SubagentViewEntry = { toolCallId: "b", task: "t2", profile: researcherProfile, run: { status: "running", startedAt: 0, items: [] }, updatedAt: 0 };
  const subbed: string[] = [];
  const comp = new SubagentDetailComponent({
    entry: e1,
    theme: testTheme,
    onClose: () => {},
    invalidate: () => {},
    entries: [e1, e2],
    index: 0,
    subscribe: (id, listener) => { subbed.push(id); return () => {}; },
  });

  assert.equal(comp.entry.toolCallId, "a");
  assert.ok(subbed.includes("a"));

  // l -> next window (vim)
  comp.handleInput("l");
  assert.equal(comp.entry.toolCallId, "b");
  assert.ok(subbed.includes("b"));

  // h -> back (vim)
  comp.handleInput("h");
  assert.equal(comp.entry.toolCallId, "a");

  // Right -> next (arrow)
  comp.handleInput("\x1b[C");
  assert.equal(comp.entry.toolCallId, "b");

  // Left -> back
  comp.handleInput("\x1b[D");
  assert.equal(comp.entry.toolCallId, "a");

  // At boundary: left cannot go before the first window
  comp.handleInput("\x1b[D");
  assert.equal(comp.entry.toolCallId, "a");

  // Toggle states are inherited across window switches (not reset)
  comp.handleInput("\x0f");
  assert.equal(comp.toolsExpanded, true);
  assert.equal(comp.statusText, "Tool output: expanded");
  comp.handleInput("\x1b[D");
  comp.handleInput("\x1b[C");
  assert.equal(comp.entry.toolCallId, "b");
  assert.equal(comp.toolsExpanded, true, "tools state inherited");
  assert.equal(comp.statusText, "Tool output: expanded", "status inherited");

  // Hint shows the navigable neighbor label
  const out = comp.render(120).join("\n");
  assert.match(out, /Researcher/);
});

test("Test 19: thinking block collapses to the + Thought label and expands with ✦ bullets (like main)", () => {
  const entry: SubagentViewEntry = {
    toolCallId: "call_think",
    task: "Task",
    profile: workerProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: [
        { kind: "thinking", text: "thinking: First thought here" },
        { kind: "thinking", text: "\u2726 Another thought\n\n\u2726 Third" },
      ],
    },
    updatedAt: 0,
  };

  const collapsedLines = formatDetailContent(entry, testTheme, 80, 5_000, false, false).join("\n");
  assert.match(collapsedLines, /\+ Thought/);
  assert.doesNotMatch(collapsedLines, /\u2726 First thought/);

  const expandedLines = formatDetailContent(entry, testTheme, 80, 5_000, false, true).join("\n");
  assert.match(expandedLines, /\u2726 First thought here/);
  assert.match(expandedLines, /\u2726 Another thought/);
  assert.match(expandedLines, /\u2726 Third/);
});

test("Test 20: MCP tool call renders a compact tool-style header", () => {
  const def = getCustomToolDefinition("exa_web_search_exa", process.cwd());
  assert.ok(def, "MCP tool should get a custom definition");

  const header = (def as unknown as { renderCall: (a: unknown, t: Theme, c: unknown) => { render(w: number): string[] } })
    .renderCall({ query: "hello world" }, testTheme, {});
  const output = header.render(80).join("\n");
  assert.match(output, /MCP\(web_search_exa\)/);
  assert.match(output, /hello world/);
});

test("Test 17: handleInput navigates with vim, arrows, half-page, full-page, home, and end", () => {
  const entry: SubagentViewEntry = {
    toolCallId: "call_scroll_test",
    task: "Long scroll testing",
    profile: workerProfile,
    run: {
      status: "running",
      startedAt: 0,
      items: Array.from({ length: 40 }, (_, i) => ({
        kind: "tool" as const,
        id: `t_${i}`,
        name: `tool_${i}`,
        status: "success" as const,
        result: `output line ${i}`,
      })),
    },
    updatedAt: 0,
  };

  let redrawCount = 0;
  const comp = new SubagentDetailComponent({
    entry,
    theme: testTheme,
    onClose: () => {},
    invalidate: () => {
      redrawCount++;
    },
    now: () => 1_000,
  });

  // Render initially with 24 rows -> innerHeight = 20, content length > 40 lines
  comp.render(120);
  const initialScrollTop = comp.scrollTop;
  assert.ok(initialScrollTop > 0, "Initially scrolled to bottom");

  // Line Up via 'k'
  comp.handleInput("k");
  assert.equal(comp.scrollTop, initialScrollTop - 1);
  assert.equal(comp.autoScroll, false);

  // Line Down via 'j'
  comp.handleInput("j");
  assert.equal(comp.scrollTop, initialScrollTop);

  // Half-page Up via ctrl+u (\x15)
  comp.handleInput("\x15");
  assert.ok(comp.scrollTop < initialScrollTop);
  const afterHalfUp = comp.scrollTop;

  // Half-page Down via ctrl+d (\x04)
  comp.handleInput("\x04");
  assert.ok(comp.scrollTop > afterHalfUp);

  // 'g' -> top
  comp.handleInput("g");
  assert.equal(comp.scrollTop, 0);

  // 'G' -> bottom
  comp.handleInput("G");
  assert.equal(comp.scrollTop, initialScrollTop);
  assert.equal(comp.autoScroll, true);
});


