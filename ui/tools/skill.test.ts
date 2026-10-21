import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { initTheme, keyText, type Theme, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Box, Container, Markdown, type Component } from "@earendil-works/pi-tui";
import { registerFileToolUi } from "./index.ts";

initTheme();
const theme = {
  fg: (_color: string, value: string) => value,
  bg: (_color: string, value: string) => value,
  bold: (value: string) => value,
} as unknown as Theme;
const tools = new Map<string, ToolDefinition>();
registerFileToolUi({
  getSettings: () => ({ outputPad: 0 }),
  registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
} as unknown as ExtensionAPI, "/workspace");
const read = tools.get("read")!;

function context(args: Record<string, unknown>, expanded = false) {
  return {
    args, cwd: "/workspace", expanded, isError: false, lastComponent: undefined,
    state: {}, executionStarted: false, invalidate: () => {}, argsComplete: true,
    isPartial: false, showImages: false, toolCallId: "skill-test",
  };
}

function text(component: Component): string {
  return component.render(160).map((line) => {
    const plain = stripVTControlCharacters(line).trimEnd();
    return component instanceof Box ? plain.replace(/^ /, "") : plain;
  }).join("\n").trim();
}

test("read calls identify exact skill basenames, ranges, aliases, and status", () => {
  const cases = [
    { args: { path: "skills/testing/SKILL.md" }, expected: "[skill] testing" },
    { args: { file_path: "skills/testing/SKILL.md", offset: 4, limit: 3 }, expected: "[skill] testing:4-6" },
    { args: { filepath: "/workspace/skills/testing/SKILL.md", limit: 2 }, expected: "[skill] testing:1-2" },
    { args: { path: "skills/testing/SKILL.md", offset: 8 }, expected: "[skill] testing:8" },
    { args: { path: "skills/testing/SKILL.md" }, state: { isPartial: true }, expected: "[skill] · testing" },
    { args: { path: "skills/testing/SKILL.md" }, state: { isPartial: true, executionStarted: true }, expected: "[skill] ◌ testing" },
    { args: { path: "skills/testing/SKILL.md" }, state: { isError: true }, expected: "[skill] ✗ testing" },
    { args: { path: "skills/testing/skill.md" }, expected: "● Read(skills/testing/skill.md)" },
    { args: { path: "skills/SKILL.md.txt", offset: 2, limit: 2 }, expected: "● Read(skills/SKILL.md.txt:2-3)" },
  ];
  for (const row of cases) {
    const component = read.renderCall!(row.args, theme, { ...context(row.args), ...row.state });
    assert.equal(text(component), row.expected + (row.expected.startsWith("[skill]") ? ` (${keyText("app.tools.expand")} to expand)` : ""));
    assert.equal(component instanceof Box, row.expected.startsWith("[skill]"));
  }
});

test("skill results strip only complete leading frontmatter at the beginning", () => {
  const cases: { name: string; source: string; offset?: number | null; expected?: string; retained?: string }[] = [
    { name: "implicit beginning", source: "---\nname: hidden\n---\nVisible body", expected: "Visible body" },
    { name: "null beginning", offset: null, source: "---\nname: hidden\n---\nVisible body", expected: "Visible body" },
    { name: "explicit beginning", offset: 1, source: "---\nname: hidden\n---\nVisible body", expected: "Visible body" },
    { name: "empty LF", source: "---\n---\nVisible body", expected: "Visible body" },
    { name: "empty CRLF", source: "---\r\n---\r\nVisible body", expected: "Visible body" },
    ...["\n", "\r\n"].map((newline) => ({
      name: `empty frontmatter preserves body before later rule (${JSON.stringify(newline)})`,
      source: ["---", "---", "Body before rule", "", "---", "", "Body after rule"].join(newline),
      retained: "Body before rule",
    })),
    { name: "CRLF", source: "---\r\nname: hidden\r\n---\r\nVisible body", expected: "Visible body" },
    { name: "closing delimiter at EOF", source: "---\nname: hidden\n---", expected: "" },
    { name: "partial frontmatter", source: "---\nname: retained", retained: "name: retained" },
    { name: "later range", offset: 2, source: "---\nname: retained\n---\nVisible body", retained: "name: retained" },
    { name: "nonleading frontmatter", source: "Introduction\n---\nname: retained\n---", retained: "name: retained" },
    { name: "limited body", source: "Visible body\n\n[15 more lines in file. Use offset=6 to continue.]", retained: "Use offset=6 to continue." },
    { name: "truncated body", source: "---\nname: hidden\n---\nVisible body\n\n[Showing lines 1-5 of 20. Use offset=6 to continue.]", retained: "Use offset=6 to continue." },
  ];
  for (const row of cases) {
    const args = { path: "skills/testing/SKILL.md", ...(row.offset === undefined ? {} : { offset: row.offset }) };
    const result = { content: [{ type: "text" as const, text: row.source }], details: undefined };
    const collapsed = read.renderResult!(result, { expanded: false, isPartial: false }, theme, context(args));
    assert.equal(text(collapsed), ["truncated body", "limited body"].includes(row.name) ? "└ Partial skill · expand to view read limits" : "", row.name);

    const expanded = read.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...context(args, true), lastComponent: collapsed });
    assert.ok(expanded instanceof Box, row.name);
    assert.ok(expanded.children[0] instanceof Container, row.name);
    assert.ok((expanded.children[0] as Container).children[0] instanceof Markdown, row.name);
    const prefix = "testing\n\nReferences are relative to /workspace/skills/testing.";
    if (row.expected !== undefined) assert.equal(text(expanded), prefix + (row.expected ? `\n\n${row.expected}` : ""), row.name);
    if (row.retained) assert.ok(text(expanded).includes(row.retained), row.name);
    if (row.source.includes("name: hidden")) assert.ok(!text(expanded).includes("name: hidden"), row.name);
  }
});

test("expanded skill calls preserve status and ranges", () => {
  const cases = [
    { name: "successful full read", args: { path: "skills/testing/SKILL.md" }, state: {}, expected: "[skill]" },
    ...[
      { name: "pending", state: { isPartial: true }, mark: "· " },
      { name: "running", state: { isPartial: true, executionStarted: true }, mark: "◌ " },
      { name: "error", state: { isError: true }, mark: "✗ " },
      { name: "success", state: {}, mark: "" },
    ].flatMap(({ name, state, mark }) => [
      ...(mark ? [{ name, args: { path: "skills/testing/SKILL.md" }, state, expected: `[skill] ${mark}testing` }] : []),
      ...[
        { range: { offset: 4, limit: 3 }, suffix: ":4-6" },
        { range: { offset: 8 }, suffix: ":8" },
        { range: { limit: 2 }, suffix: ":1-2" },
      ].map(({ range, suffix }) => ({
        name: `${name} ${suffix}`, args: { path: "skills/testing/SKILL.md", ...range }, state,
        expected: `[skill] ${mark}testing${suffix}`,
      })),
    ]),
  ];
  for (const row of cases) {
    const component = read.renderCall!(row.args, theme, { ...context(row.args, true), ...row.state });
    assert.equal(text(component), row.expected, row.name);
    assert.ok(component instanceof Box, row.name);
  }
});

test("expanded skill references resolve home, relative, and absolute paths", () => {
  const cases = [
    { path: "~/skills/testing/SKILL.md", directory: join(homedir(), "skills/testing") },
    { path: "skills/testing/SKILL.md", directory: "/workspace/skills/testing" },
    { path: "/opt/skills/testing/SKILL.md", directory: "/opt/skills/testing" },
  ];
  for (const row of cases) {
    const args = { path: row.path };
    const result = { content: [{ type: "text" as const, text: "Visible body" }], details: undefined };
    const component = read.renderResult!(result, { expanded: true, isPartial: false }, theme, context(args, true));
    assert.equal(text(component), `testing\n\nReferences are relative to ${row.directory}.\n\nVisible body`, row.path);
  }
});

test("skill layout preserves native spacing and reuses renderer slots", () => {
  const args = { path: "skills/testing/SKILL.md", offset: null, limit: null };
  const collapsed = read.renderCall!(args, theme, context(args));
  assert.deepEqual(collapsed.render(80).map((line) => stripVTControlCharacters(line).trimEnd()), ["", ` [skill] testing (${keyText("app.tools.expand")} to expand)`, ""]);
  const expanded = read.renderCall!(args, theme, { ...context(args, true), lastComponent: collapsed });
  assert.equal(expanded, collapsed);
  assert.deepEqual(expanded.render(80).map((line) => stripVTControlCharacters(line).trimEnd()), ["", " [skill]"]);

  const result = { content: [{ type: "text" as const, text: "---\nname: hidden\n---\nBody" }], details: undefined };
  const first = read.renderResult!(result, { expanded: true, isPartial: false }, theme, context(args, true));
  const second = read.renderResult!(result, { expanded: true, isPartial: false }, theme, { ...context(args, true), lastComponent: first });
  assert.equal(second, first);
  assert.equal(stripVTControlCharacters(second.render(80).at(-1)!).trim(), "");
  assert.ok(!text(second).includes("name: hidden"));
});

test("skill cards do not stack tool padding on their own inset", () => {
  const register = (outputPad: number) => registerFileToolUi({
    getSettings: () => ({ outputPad }),
    registerTool: () => {},
  } as unknown as ExtensionAPI, "/workspace");
  register(1);
  try {
    for (const path of ["skills/testing/SKILL.md", "notes.txt"]) {
      const component = read.renderCall!({ path }, theme, context({ path }));
      const line = component.render(100).map(stripVTControlCharacters).find((value) => value.trim())!;
      assert.ok(line.startsWith(" "), path);
      assert.ok(!line.startsWith("  "), path);
    }
  } finally {
    register(0);
  }
});

test("errors use normal error results and ordinary reads retain their rendering", () => {
  const cases = [
    { path: "skills/testing/SKILL.md", expanded: false, isError: true, expected: "└ First failure" },
    { path: "skills/testing/SKILL.md", expanded: true, isError: true, expected: "First failure\n  Second failure" },
    { path: "notes.txt", expanded: false, isError: true, expected: "└ First failure" },
    { path: "notes.txt", expanded: true, isError: true, expected: "First failure\n  Second failure" },
    { path: "notes.txt", expanded: false, isError: false, expected: "└ 2 lines" },
    { path: "notes.txt", expanded: true, isError: false, expected: "First failure\n  Second failure" },
  ];
  for (const row of cases) {
    const args = { path: row.path };
    const result = { content: [{ type: "text" as const, text: "First failure\nSecond failure" }], details: undefined };
    const component = read.renderResult!(result, { expanded: row.expanded, isPartial: false }, theme, { ...context(args, row.expanded), isError: row.isError });
    assert.equal(text(component), row.expected, JSON.stringify(row));
    assert.ok(!(component instanceof Box));
  }
});
