import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskRecord } from "pi-rostrix";
import type { Theme } from "../subagent/format.ts";
import { renderMonitorPanel } from "./panel.ts";
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
      toolsCount: 8,
      skills: ["plan", "debug", "docs"],
      mcpServers: ["pi-agy-bridge_pi"],
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
      total: 10,
      errors: 1,
      activeTools: [],
      counts: { edit: 10 },
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

test("renderMonitorPanel renders full-width 3-column layout when width >= 95 and stacked layout when narrow", () => {
  const cases = [
    { name: "wide 3-column layout", width: 110, expectColumnsOnSameRow: true },
    { name: "narrow stacked layout", width: 72, expectColumnsOnSameRow: false },
  ];

  for (const tc of cases) {
    const lines = renderMonitorPanel(makeSnapshot(), mockTheme, tc.width, 70_000);
    const joined = lines.join("\n");

    assert.ok(lines[0]?.startsWith("─ Monitor "), `${tc.name}: expected Monitor rule`);
    assert.ok(lines.every((line) => visibleWidth(line) === tc.width), `${tc.name}: exact width`);
    assert.ok(joined.includes("Git feat/issue-27  2 files · +14 -3"), `${tc.name}: git header`);
    assert.ok(joined.includes("Agent default"), `${tc.name}: agent header`);
    assert.ok(joined.includes("tool: 8"), `${tc.name}: tool count`);
    assert.ok(joined.includes("└ 10 calls (90%)"), `${tc.name}: tool usage child line`);
    assert.ok(joined.includes("skill: 3"), `${tc.name}: skill count`);
    assert.ok(joined.includes("└ plan, debug, docs"), `${tc.name}: skill list child line`);
    assert.ok(joined.includes("mcp: 1"), `${tc.name}: mcp count`);
    assert.ok(joined.includes("└ pi-agy-bridge_pi"), `${tc.name}: mcp list child line`);
    assert.ok(joined.includes("Subagent (1 running)"), `${tc.name}: subagent header`);
    assert.ok(joined.includes("● worker") && joined.includes("• medium"), `${tc.name}: active worker with level`);
    assert.ok(joined.includes("○ researcher") && joined.includes("• low"), `${tc.name}: researcher with level`);
    assert.ok(joined.includes("└ ◌ 1m · Edit"), `${tc.name}: running task tool`);
    assert.ok(joined.includes("○ custom"), `${tc.name}: finished fallback agent uses dim marker`);

    const headerRow = lines.find((line) => line.includes("Git ") && line.includes("Agent "));
    assert.equal(Boolean(headerRow), tc.expectColumnsOnSameRow, `${tc.name}: column placement`);
  }
});

test("renderMonitorPanel omits 'clean' on empty git diff and renders 'none' for empty agent resources", () => {
  const snapshot = makeSnapshot({
    git: {
      isRepo: true,
      branch: "main",
      ahead: 0,
      behind: 0,
      totalInsertions: 0,
      totalDeletions: 0,
      files: [],
    },
    mainResources: {
      toolsCount: 4,
      skills: [],
      mcpServers: [],
    },
    tools: {
      total: 0,
      errors: 0,
      activeTools: [],
      counts: {},
    },
  });

  const joined = renderMonitorPanel(snapshot, mockTheme, 110, 70_000).join("\n");

  assert.ok(!joined.includes("clean"), "must not render 'clean'");
  assert.ok(joined.includes("skill: none"));
  assert.ok(joined.includes("mcp: none"));
});
