import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskRecord } from "pi-rostrix";
import type { Theme } from "../subagent/format.ts";
import {
  renderFooterLine1,
  renderFooterLine2,
  renderMonitorFooter,
} from "./footer.ts";
import type { MonitorSnapshot } from "./state.ts";

const mockTheme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeTask(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    agentId: "gear:researcher",
    task: "inspect",
    depth: 1,
    targetFiles: [],
    wakeOn: [],
    status: "running",
    revision: 1,
    createdAt: 1000,
    startedAt: 1000,
    lastActivityAt: 1000,
    activities: [],
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    cwd: "/Users/alice/Developer/pi-gear",
    home: "/Users/alice",
    sessionName: undefined,
    activeAgent: "default",
    model: {
      provider: "anthropic",
      id: "claude-sonnet-4-6",
      reasoning: true,
      thinkingLevel: "medium",
      usingSubscription: false,
    },
    availableProviderCount: 1,
    sessionUsage: {
      input: 1200,
      output: 340,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.045,
      contextTokens: 36800,
      contextPercent: 18.4,
      contextWindow: 200000,
      turns: 2,
    },
    git: {
      isRepo: true,
      branch: "main",
      ahead: 0,
      behind: 0,
      totalInsertions: 0,
      totalDeletions: 0,
      files: [],
    },
    tools: {
      total: 4,
      errors: 1,
      activeTools: [],
    },
    tasks: [],
    extensionStatuses: new Map(),
    ...overrides,
  };
}

test("renderFooterLine1 formats agent-prefixed workspace, branch diff without parens, running subagent, and right-aligned activity", () => {
  const cases = [
    {
      name: "with git diff, 1 running task, active tools, and error rate",
      snapshot: makeSnapshot({
        git: {
          isRepo: true,
          branch: "feat/monitor",
          ahead: 2,
          behind: 1,
          totalInsertions: 12,
          totalDeletions: 3,
          files: [{ path: "a.ts", state: "M", insertions: 12, deletions: 3, binary: false }],
        },
        tools: {
          total: 10,
          errors: 1,
          activeTools: ["bash"],
        },
        tasks: [makeTask({ agentId: "gear:worker", status: "running", startedAt: 10_000 })],
      }),
      now: 85_000,
      expectedPrefix: "(default) ~/Developer/pi-gear │ ⎇ feat/monitor +12 -3 │ ◌ worker (1m 15s)",
      expectedSuffix: "↻ step 2 · ⚙ activity 10 (+1) (90%)",
      forbidden: ["↑2", "↓1", "✕", "▴", "▾", "(feat/monitor"],
    },
    {
      name: "with untracked-only git state and multiple running tasks",
      snapshot: makeSnapshot({
        git: {
          isRepo: true,
          branch: "main",
          ahead: 0,
          behind: 0,
          totalInsertions: 0,
          totalDeletions: 0,
          files: [{ path: "new.ts", state: "?", insertions: 0, deletions: 0, binary: false }],
        },
        tools: {
          total: 4,
          errors: 0,
          activeTools: [],
        },
        tasks: [
          makeTask({ id: "t1", agentId: "gear:reviewer", status: "running", startedAt: 10_000 }),
          makeTask({ id: "t2", agentId: "gear:researcher", status: "running", startedAt: 50_000 }),
        ],
      }),
      now: 70_000,
      expectedPrefix: "(default) ~/Developer/pi-gear │ ⎇ main* │ ◌ 2 reviewer (1m)",
      expectedSuffix: "↻ step 2 · ⚙ activity 4 (100%)",
      forbidden: ["✕", "▴", "▾", "(main*"],
    },
    {
      name: "clean repo without running tasks",
      snapshot: makeSnapshot(),
      now: 70_000,
      expectedPrefix: "(default) ~/Developer/pi-gear │ ⎇ main",
      expectedSuffix: "↻ step 2 · ⚙ activity 4 (75%)",
      forbidden: ["✕", "▴", "▾", "(main)"],
    },
  ];

  for (const tc of cases) {
    const line = renderFooterLine1(tc.snapshot, mockTheme, 160, tc.now);

    assert.equal(visibleWidth(line), 160, tc.name);
    assert.ok(line.startsWith(tc.expectedPrefix), `${tc.name}: expected prefix "${tc.expectedPrefix}" in "${line}"`);
    assert.ok(line.endsWith(tc.expectedSuffix), `${tc.name}: expected suffix "${tc.expectedSuffix}" in "${line}"`);
    for (const bad of tc.forbidden) {
      assert.ok(!line.includes(bad), `${tc.name}: unexpected "${bad}" in "${line}"`);
    }
  }
});

test("renderFooterLine2 and renderMonitorFooter preserve native Line 2 stats and extension statuses", () => {
  const snapshot = makeSnapshot({
    extensionStatuses: new Map([["b", "ext-b"], ["a", "ext-a"]]),
  });

  const line2 = renderFooterLine2(snapshot, mockTheme, 100);
  const lines = renderMonitorFooter(snapshot, mockTheme, 100, 1000);

  assert.equal(visibleWidth(line2), 100);
  assert.ok(line2.includes("↑1.2k ↓340 $0.045 18.4%/200k (auto)"));
  assert.ok(line2.includes("claude-sonnet-4-6 • medium"));
  assert.equal(lines.length, 3);
  assert.equal(lines[2], "ext-a ext-b");
});
