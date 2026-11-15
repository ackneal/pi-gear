import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { renderSidebar, SIDEBAR_WIDTH, sidebarOverlayOptions } from "./sidebar.ts";
import { extractMainAgentResources, type MonitorSnapshot } from "./state.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  bg: (_color: string, text: string) => text,
};

function makeSnapshot(overrides: Partial<MonitorSnapshot> = {}): MonitorSnapshot {
  return {
    cwd: "/Users/dev/project",
    home: "/Users/dev",
    git: {
      isRepo: true,
      branch: "feat/sidebar",
      ahead: 2,
      behind: 0,
      files: [
        { path: "src/staged.ts", state: "S", insertions: 10, deletions: 1, binary: false },
        { path: "src/both.ts", state: "SM", insertions: 8, deletions: 2, binary: false },
        { path: "src/new.ts", state: "?", insertions: 0, deletions: 0, binary: false },
      ],
      totalInsertions: 18,
      totalDeletions: 3,
    },
    activeAgent: "default",
    mainResources: {
      toolsCount: 7,
      skills: ["coding-principles", "to-artifact"],
      mcpServers: ["exa", "gh_grep"],
    },
    agents: [
      { id: "gear:worker", model: "agy/gemini-4" },
      { id: "gear:researcher" },
      { id: "gear:reviewer", model: "agy/claude-4" },
    ],
    tasks: [
      {
        taskId: "t1",
        agentId: "gear:worker",
        status: "running",
        startedAt: 10_000,
        activities: [{ kind: "tool", id: "1", name: "mcp__exa__web_search_exa", status: "running" }],
      } as never,
    ],
    tools: {
      total: 9,
      errors: 1,
      activeTools: [],
      counts: { read: 5, edit: 3, bash: 1 },
    },
    sessionUsage: {
      turns: 3,
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0.042,
      contextTokens: 42_000,
      contextWindow: 200_000,
      contextPercent: 21,
    },
    availableProviderCount: 1,
    extensionStatuses: new Map(),
    ...overrides,
  };
}

test("renderSidebar renders Git diff, Main Agent resources, and nested Subagent tasks within exact width", () => {
  const lines = renderSidebar(makeSnapshot(), theme, SIDEBAR_WIDTH, 85_000).map(stripVTControlCharacters);
  const full = lines.join("\n");

  for (const line of lines) {
    assert.equal(line.length, SIDEBAR_WIDTH, `expected line width ${SIDEBAR_WIDTH}: "${line}"`);
  }

  for (const expected of [
    "┌─ Monitor ",
    "Git feat/sidebar ↑2",
    "3 changed · +18 -3",
    "S  src/staged.ts",
    "SM src/both.ts",
    "?  src/new.ts",
    "Agent default",
    "tool: 7 (9 calls) · 1 err",
    "skill: 2 (coding-principles, ...",
    "mcp: 2 (exa, gh_grep)",
    "Subagent (1 running)",
    "● worker gemini-4",
    "└ ◌ 1m 15s · Exa search",
    "○ researcher",
    "○ reviewer claude-4",
  ]) {
    assert.ok(full.includes(expected), `expected "${expected}" in sidebar:\n${full}`);
  }
});

test("extractMainAgentResources separates built-in tools, skills, and MCP servers", () => {
  const resources = extractMainAgentResources(
    ["read", "edit", "bash", "mcp__exa__web_search_exa", "mcp__gh_grep__searchGitHub"],
    [
      { name: "gear:doctor", source: "extension" },
      { name: "skill:coding-principles", source: "skill" },
    ],
    ["custom_mcp"],
  );

  assert.deepEqual(resources, {
    toolsCount: 3,
    skills: ["coding-principles"],
    mcpServers: ["custom_mcp", "exa", "gh_grep"],
  });
});

test("sidebarOverlayOptions configures nonCapturing top-right overlay and responsive visibility", () => {
  const cases = [
    { name: "auto-expanded on >=130", manual: undefined, width: 130, expected: true },
    { name: "auto-collapsed on 95-129", manual: undefined, width: 120, expected: false },
    { name: "manually expanded on 100", manual: true, width: 100, expected: true },
    { name: "hidden on <95 even if manually expanded", manual: true, width: 94, expected: false },
  ];

  for (const row of cases) {
    const opts = sidebarOverlayOptions(() => row.manual);
    assert.equal(opts.nonCapturing, true);
    assert.equal(opts.anchor, "top-right");
    assert.equal(opts.visible?.(row.width, 40), row.expected, row.name);
  }
});
