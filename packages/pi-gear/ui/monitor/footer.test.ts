import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderFooterLine1, renderFooterLine2, renderMonitorFooter } from "./footer.ts";
import { createToolStatsTracker, summarizeSessionUsage, type MonitorSnapshot } from "./state.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

function baseSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    cwd: "/Users/dev/project",
    home: "/Users/dev",
    git: {
      isRepo: true,
      branch: "main",
      ahead: 1,
      behind: 0,
      files: [{ path: "src/app.ts", state: "M", insertions: 5, deletions: 2, binary: false }],
      totalInsertions: 5,
      totalDeletions: 2,
    },
    activeAgent: "default",
    mainResources: { toolsCount: 7, skills: ["coding-principles"], mcpServers: ["exa"] },
    agents: [],
    tasks: [],
    tools: { total: 4, errors: 0, activeTools: [], counts: { read: 3, edit: 1 } },
    sessionUsage: {
      turns: 2,
      input: 1600,
      output: 300,
      cacheRead: 16_000,
      cacheWrite: 0,
      cost: 0.123,
      cacheHitRate: 90.9,
      contextTokens: 42_000,
      contextWindow: 200_000,
      contextPercent: 21,
    },
    model: {
      id: "gemini-4-hydrogen",
      provider: "agy",
      reasoning: true,
      thinkingLevel: "medium",
      usingSubscription: true,
    },
    availableProviderCount: 2,
    extensionStatuses: new Map(),
    ...overrides,
  };
}

test("renderFooterLine1 renders workspace, branch, main agent, running agents, tools, and right-aligned icon", () => {
  const now = 100_000;
  const cases = [
    {
      name: "collapsed wide terminal shows ◂ on far right",
      width: 110,
      manualExpanded: undefined,
      snapshot: baseSnapshot({
        activeAgent: "gear:worker",
        tasks: [
          {
            taskId: "t1",
            agentId: "gear:researcher",
            status: "running",
            startedAt: now - 75_000,
            activities: [],
          } as never,
        ],
      }),
      expectedSubstrings: ["~/project (main* ↑1)", "gear:worker", "◌ researcher (1m 15s)", "↻ step 2 · ⚙ activity 4"],
      expectedEnd: "◂",
    },
    {
      name: "expanded wide terminal shows ▸ on far right and multiple running agents",
      width: 140,
      manualExpanded: undefined,
      snapshot: baseSnapshot({
        tasks: [
          { taskId: "t1", agentId: "gear:worker", status: "running", startedAt: now - 10_000, activities: [] } as never,
          { taskId: "t2", agentId: "gear:reviewer", status: "running", startedAt: now - 75_000, activities: [] } as never,
        ],
        tools: { total: 2, errors: 1, activeTools: ["bash"], counts: { bash: 2 } },
      }),
      expectedSubstrings: ["~/project (main* ↑1)", "default", "◌ 2 reviewer (1m 15s)", "↻ step 2 · ⚙ activity 2 (+1) ✕1"],
      expectedEnd: "▸",
    },
    {
      name: "narrow terminal hides sidebar icon",
      width: 80,
      manualExpanded: true,
      snapshot: baseSnapshot(),
      expectedSubstrings: ["~/project (main* ↑1)", "default"],
      expectedEnd: undefined,
    },
  ];

  for (const row of cases) {
    const rendered = stripVTControlCharacters(
      renderFooterLine1(row.snapshot, theme, row.width, row.manualExpanded, now),
    );
    for (const part of row.expectedSubstrings) {
      assert.ok(rendered.includes(part), `${row.name}: expected "${part}" in "${rendered}"`);
    }
    if (row.expectedEnd) {
      assert.ok(rendered.endsWith(row.expectedEnd), `${row.name}: expected end "${row.expectedEnd}", got "${rendered}"`);
      assert.equal(rendered.length, row.width, `${row.name}: exact width padding`);
    } else {
      assert.ok(!rendered.includes("◂") && !rendered.includes("▸"), `${row.name}: no sidebar icon`);
    }
  }
});

test("renderFooterLine2 preserves native Pi stats and right-aligned model", () => {
  const line2 = stripVTControlCharacters(renderFooterLine2(baseSnapshot(), theme, 120));
  assert.ok(line2.includes("↑1.6k ↓300 R16k CH90.9% $0.123 (sub) 21.0%/200k (auto)"));
  assert.ok(line2.endsWith("(agy) gemini-4-hydrogen • medium"));
  assert.equal(line2.length, 120);
});

test("renderMonitorFooter appends sorted extension statuses on line 3", () => {
  const lines = renderMonitorFooter(
    baseSnapshot({
      extensionStatuses: new Map([
        ["z", "lsp: ready"],
        ["a", "sandbox: on"],
      ]),
    }),
    theme,
    120,
    false,
  ).map(stripVTControlCharacters);

  assert.equal(lines.length, 3);
  assert.equal(lines[2], "sandbox: on lsp: ready");
});

test("ToolStatsTracker and summarizeSessionUsage aggregate session entries", () => {
  const tracker = createToolStatsTracker();
  tracker.recordStart("c1", "read");
  assert.deepEqual(tracker.snapshot().activeTools, ["read"]);
  tracker.recordEnd("c1", "read", false);
  tracker.recordEnd("c2", "bash", true);
  assert.equal(tracker.snapshot().total, 2);
  assert.equal(tracker.snapshot().errors, 1);
  assert.deepEqual(tracker.snapshot().counts, { read: 1, bash: 1 });

  const entries = [
    {
      type: "message",
      message: {
        role: "assistant",
        usage: { input: 1000, output: 200, cacheRead: 3000, cacheWrite: 0, cost: { total: 0.05 } },
      },
    },
    {
      type: "message",
      message: { role: "toolResult", toolName: "read", isError: false },
    },
  ];
  tracker.resetFromEntries(entries);
  assert.equal(tracker.snapshot().total, 1);

  const usage = summarizeSessionUsage(entries, { tokens: 4000, contextWindow: 100_000, percent: 4 });
  assert.equal(usage.turns, 1);
  assert.equal(usage.input, 1000);
  assert.equal(usage.output, 200);
  assert.equal(usage.cacheRead, 3000);
  assert.equal(usage.cost, 0.05);
  assert.equal(usage.cacheHitRate, 75);
});
