import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskRecord } from "pi-rostrix";
import type { Theme } from "../subagent/format.ts";
import { renderMonitorPanel, renderMonitorSidebar } from "./panel.ts";
import type { MonitorSnapshot } from "./state.ts";

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    agentId: "gear:worker",
    task: "implement",
    depth: 1,
    targetFiles: [],
    wakeOn: [],
    status: "running",
    revision: 1,
    createdAt: 1000,
    startedAt: 1000,
    lastActivityAt: 1000,
    activities: [{ kind: "tool", name: "edit", status: "running" }],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    cwd: "/Users/alice/Developer/pi-gear",
    home: "/Users/alice",
    activeAgent: "default",
    agents: [
      { id: "gear:researcher", model: "anthropic/claude-haiku", thinkingLevel: "low" },
      { id: "gear:worker", model: "anthropic/claude-sonnet-4-6", thinkingLevel: "medium" },
    ],
    mainResources: {
      toolsCount: 4,
      tools: ["read", "edit", "bash", "grep"],
      skills: ["plan", "debug", "docs"],
      mcpServers: ["pi_agy_bridge_pi"],
    },
    model: undefined,
    availableProviderCount: 1,
    sessionUsage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      contextPercent: 0,
      contextWindow: 200000,
      turns: 1,
    },
    git: {
      isRepo: true,
      branch: "feat/issue-27",
      ahead: 0,
      behind: 0,
      totalInsertions: 14,
      totalDeletions: 3,
      files: [
        { path: "packages/pi-gear/ui/monitor/panel.ts", state: "M", insertions: 10, deletions: 2, binary: false },
        { path: "packages/pi-gear/ui/monitor/footer.ts", state: "S", insertions: 4, deletions: 1, binary: false },
      ],
    },
    tools: {
      total: 12,
      errors: 1,
      activeTools: [],
      counts: {
        edit: 6,
        bash: 4,
        mcp__pi_agy_bridge_pi__read_file: 2,
      },
      byTool: {
        edit: { calls: 6, errors: 0 },
        bash: { calls: 4, errors: 1 },
        mcp__pi_agy_bridge_pi__read_file: { calls: 2, errors: 0 },
      },
    },
    tasks: [
      makeTask({ id: "t1", agentId: "gear:worker", status: "running", startedAt: 10_000 }),
      makeTask({
        id: "t2",
        agentId: "gear:custom",
        status: "completed",
        startedAt: 5_000,
        finishedAt: 20_000,
        activities: [],
      }),
    ],
    extensionStatuses: new Map(),
    ...overrides,
  };
}

test("renderMonitorPanel renders 3-column git layout and per-tool/mcp success rates", () => {
  const cases = [
    { name: "wide 3-column layout", width: 120, expectColumnsOnSameRow: true },
    { name: "narrow stacked layout", width: 72, expectColumnsOnSameRow: false },
  ];

  for (const tc of cases) {
    const lines = renderMonitorPanel(makeSnapshot(), mockTheme, tc.width, 70_000, false);
    const joined = lines.join("\n");

    assert.ok(lines[0]?.startsWith("─ Monitor "), `${tc.name}: expected Monitor rule`);
    assert.ok(lines[0]?.endsWith("─"), `${tc.name}: expected clean top rule without inline button`);
    assert.ok(lines.every((line) => visibleWidth(line) === tc.width), `${tc.name}: exact width`);
    assert.ok(joined.includes("Git feat/issue-27  2 files (+14 -3)"), `${tc.name}: git header`);
    assert.ok(joined.includes("Agent default"), `${tc.name}: agent header`);
    assert.ok(joined.includes("tool: 4  (12 calls · 92%)"), `${tc.name}: tool summary`);
    assert.ok(joined.includes("edit 100%") && joined.includes("bash 75%"), `${tc.name}: per-tool rates`);
    assert.ok(joined.includes("skill: 3"), `${tc.name}: skill count`);
    assert.ok(joined.includes("└ plan, debug, docs"), `${tc.name}: skill list child line`);
    assert.ok(joined.includes("mcp: 1"), `${tc.name}: mcp count`);
    assert.ok(joined.includes("└ pi_agy_bridge_pi 100%"), `${tc.name}: mcp rate child line`);
    assert.ok(joined.includes("Subagent (1 running)"), `${tc.name}: subagent header`);
    assert.ok(joined.includes("● worker") && joined.includes("• medium"), `${tc.name}: active worker with level`);
    assert.ok(joined.includes("○ researcher") && joined.includes("• low"), `${tc.name}: researcher with level`);
    assert.ok(joined.includes("└ ◌ 1m · Edit"), `${tc.name}: running task tool`);
    assert.ok(joined.includes("○ custom"), `${tc.name}: finished fallback agent uses dim marker`);

    const headerRow = lines.find((line) => line.includes("Git ") && line.includes("Agent "));
    assert.equal(Boolean(headerRow), tc.expectColumnsOnSameRow, `${tc.name}: column placement`);
  }
});

test("renderMonitorPanel hides Git section when workspace is not a git repo and supports full detail mode", () => {
  const snapshot = makeSnapshot({
    git: {
      isRepo: false,
      ahead: 0,
      behind: 0,
      totalInsertions: 0,
      totalDeletions: 0,
      files: [],
    },
    mainResources: {
      toolsCount: 3,
      tools: ["read", "edit", "bash"],
      skills: [],
      mcpServers: [],
    },
    tools: {
      total: 10,
      errors: 1,
      activeTools: [],
      counts: { edit: 6, bash: 4 },
      byTool: {
        edit: { calls: 6, errors: 0 },
        bash: { calls: 4, errors: 1 },
      },
    },
  });

  const lines = renderMonitorPanel(snapshot, mockTheme, 100, 70_000, true);
  const joined = lines.join("\n");

  assert.ok(!joined.includes("Git "), "must hide Git section when not a git repo");
  assert.ok(joined.includes("edit (6 · 100%)"), "full mode shows call count + rate");
  assert.ok(joined.includes("bash (4 · 75%)"), "full mode shows call count + rate");
  assert.ok(joined.includes("read"), "full mode includes uncalled tools");
  assert.ok(joined.includes("skill: none"));
  assert.ok(joined.includes("mcp: none"));
});

test("renderMonitorSidebar renders vertical sidebar sections within exact sidebar width", () => {
  const lines = renderMonitorSidebar(makeSnapshot(), mockTheme, 38, 70_000, false);
  const joined = lines.join("\n");

  assert.ok(lines[0]?.startsWith("─ Monitor "));
  assert.ok(lines.every((line) => visibleWidth(line) === 38), "exact sidebar width");
  assert.ok(joined.includes("Git feat/issue-27"));
  assert.ok(joined.includes("Agent default"));
  assert.ok(joined.includes("Subagent (1 running)"));
});
