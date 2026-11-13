import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { highlightCode, initTheme, keyText, type Theme, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
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

test("supplementary files inside a skill directory render with skill UI in collapsed and expanded views", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-gear-skill-dir-"));
  const skillDir = join(root, "skills", "to-artifact");
  const refsDir = join(skillDir, "references");
  const nestedDir = join(skillDir, "assets", "templates");
  const outsideDir = join(root, "outside");
  mkdirSync(refsDir, { recursive: true });
  mkdirSync(nestedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: to-artifact\n---\nBody");
  writeFileSync(join(refsDir, "jira.md"), "---\ntitle: Jira\n---\n# Jira Template");
  writeFileSync(join(nestedDir, "spec.txt"), "Spec template body");
  writeFileSync(join(outsideDir, "notes.md"), "Outside skill directory");

  try {
    const expandHint = ` (${keyText("app.tools.expand")} to expand)`;
    const callCases = [
      {
        name: "collapsed supplementary file",
        args: { path: "skills/to-artifact/references/jira.md" },
        expanded: false,
        state: {},
        expected: `[skill] to-artifact: references/jira.md${expandHint}`,
        isBox: true,
      },
      {
        name: "collapsed nested supplementary file with range",
        args: { file_path: join(nestedDir, "spec.txt"), offset: 2, limit: 4 },
        expanded: false,
        state: {},
        expected: `[skill] to-artifact: assets/templates/spec.txt:2-5${expandHint}`,
        isBox: true,
      },
      {
        name: "collapsed supplementary file with running status",
        args: { path: "skills/to-artifact/references/jira.md" },
        expanded: false,
        state: { isPartial: true, executionStarted: true },
        expected: `[skill] ◌ to-artifact: references/jira.md${expandHint}`,
        isBox: true,
      },
      {
        name: "expanded supplementary file",
        args: { path: "skills/to-artifact/references/jira.md" },
        expanded: true,
        state: {},
        expected: "[skill] to-artifact: references/jira.md",
        isBox: true,
      },
      {
        name: "expanded supplementary file with range and error",
        args: { path: "skills/to-artifact/references/jira.md", offset: 5 },
        expanded: true,
        state: { isError: true },
        expected: "[skill] ✗ to-artifact: references/jira.md:5",
        isBox: true,
      },
      {
        name: "outside skill directory retains ordinary read call",
        args: { path: "outside/notes.md" },
        expanded: false,
        state: {},
        expected: "● Read(outside/notes.md)",
        isBox: false,
      },
    ];

    for (const row of callCases) {
      const ctx = { ...context(row.args, row.expanded), cwd: root, ...row.state };
      const component = read.renderCall!(row.args, theme, ctx);
      assert.equal(text(component), row.expected, row.name);
      assert.equal(component instanceof Box, row.isBox, row.name);
    }

    const resultCases: {
      name: string;
      args: Record<string, unknown>;
      source: string;
      details?: Record<string, unknown>;
      expanded: boolean;
      isError?: boolean;
      expected: string;
      isBox: boolean;
    }[] = [
      {
        name: "collapsed supplementary file hides body when complete",
        args: { path: "skills/to-artifact/references/jira.md" },
        source: "---\ntitle: Jira\n---\n# Jira Template",
        expanded: false,
        expected: "",
        isBox: false,
      },
      {
        name: "collapsed supplementary file reports partial read limits from text notice",
        args: { path: "skills/to-artifact/references/jira.md" },
        source: "Line 1\n\n[10 more lines in file. Use offset=2 to continue.]",
        expanded: false,
        expected: "└ Partial file · expand to view read limits",
        isBox: false,
      },
      {
        name: "collapsed supplementary file reports partial read limits from details.truncation",
        args: { path: "skills/to-artifact/references/jira.md" },
        source: "Line 1",
        details: { truncation: { truncated: true, outputLines: 1 } },
        expanded: false,
        expected: "└ Partial file · expand to view read limits",
        isBox: false,
      },
      {
        name: "expanded supplementary file preserves frontmatter and renders inside skill box",
        args: { path: "skills/to-artifact/references/jira.md" },
        source: "---\ntitle: Jira\n---\n# Jira Template",
        expanded: true,
        expected: "---\ntitle: Jira\n---\n# Jira Template",
        isBox: true,
      },
      {
        name: "expanded partial supplementary file renders full content inside skill box",
        args: { path: "skills/to-artifact/references/jira.md" },
        source: "Line 1\n\n[10 more lines in file. Use offset=2 to continue.]",
        details: { truncation: { truncated: true, outputLines: 1 } },
        expanded: true,
        expected: "Line 1\n\n[10 more lines in file. Use offset=2 to continue.]",
        isBox: true,
      },
      {
        name: "collapsed supplementary file error uses single-line error summary",
        args: { path: "skills/to-artifact/references/jira.md" },
        source: "First failure\nSecond failure",
        expanded: false,
        isError: true,
        expected: "└ First failure",
        isBox: false,
      },
      {
        name: "expanded supplementary file error uses detail error output",
        args: { path: "skills/to-artifact/references/jira.md" },
        source: "First failure\nSecond failure",
        expanded: true,
        isError: true,
        expected: "First failure\n  Second failure",
        isBox: false,
      },
    ];

    for (const row of resultCases) {
      const ctx = { ...context(row.args, row.expanded), cwd: root, isError: row.isError ?? false };
      const component = read.renderResult!({ content: [{ type: "text" as const, text: row.source }], details: row.details }, { expanded: row.expanded, isPartial: false }, theme, ctx);
      assert.equal(component instanceof Box, row.isBox, row.name);
      assert.equal(text(component), row.expected, row.name);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("non-Markdown supplementary files use highlightCode for code and customMessageText for plain text", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-gear-skill-non-md-"));
  const skillDir = join(root, "skills", "to-artifact");
  const scriptsDir = join(skillDir, "scripts");
  const assetsDir = join(skillDir, "assets");
  mkdirSync(scriptsDir, { recursive: true });
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: to-artifact\n---\nBody");
  writeFileSync(join(scriptsDir, "helper.ts"), "const answer = 42;\r\n\treturn answer;");
  writeFileSync(join(assetsDir, "spec.txt"), "Line 1\r\n\tLine 2");

  try {
    const cases = [
      {
        name: "TypeScript supplementary file uses highlightCode",
        path: "skills/to-artifact/scripts/helper.ts",
        source: "const answer = 42;\r\n\treturn answer;",
        expectedText: "const answer = 42;\n  return answer;",
        expectedHighlighted: highlightCode("const answer = 42;\n  return answer;", "typescript"),
        expectedCustomMessageCalls: [] as string[],
      },
      {
        name: "plain text supplementary file uses customMessageText",
        path: "skills/to-artifact/assets/spec.txt",
        source: "Line 1\r\n\tLine 2",
        expectedText: "Line 1\n  Line 2",
        expectedHighlighted: undefined,
        expectedCustomMessageCalls: ["Line 1", "  Line 2"],
      },
    ];

    for (const row of cases) {
      const customMessageCalls: string[] = [];
      const spyTheme = {
        fg: (color: string, value: string) => {
          if (color === "customMessageText") customMessageCalls.push(value);
          return value;
        },
        bg: (_color: string, value: string) => value,
        bold: (value: string) => value,
      } as unknown as Theme;

      const ctx = { ...context({ path: row.path }, true), cwd: root };
      const component = read.renderResult!(
        { content: [{ type: "text" as const, text: row.source }], details: undefined },
        { expanded: true, isPartial: false },
        spyTheme,
        ctx,
      );
      assert.ok(component instanceof Box, row.name);
      assert.equal(text(component), row.expectedText, row.name);
      assert.deepEqual(customMessageCalls, row.expectedCustomMessageCalls, row.name);

      const rawOutput = component.render(160).join("\n");
      if (row.expectedHighlighted) {
        for (const highlightedLine of row.expectedHighlighted) {
          assert.ok(rawOutput.includes(highlightedLine), `${row.name}: missing highlighted line`);
        }
      } else {
        assert.equal(stripVTControlCharacters(rawOutput), rawOutput, row.name);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("skill resolution handles real directories, cwd inside skill dir, symlinked skill dirs, and cyclic SKILL.md symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-gear-skill-resolve-"));
  const skillDir = join(root, "skills", "to-artifact");
  const refsDir = join(skillDir, "references");
  const linkedSkillDir = join(root, "skills", "linked-artifact");
  const loopDir = join(root, "skills", "loop-skill");
  mkdirSync(refsDir, { recursive: true });
  mkdirSync(loopDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: to-artifact\n---\nBody");
  writeFileSync(join(refsDir, "jira.md"), "# Jira Template");
  writeFileSync(join(loopDir, "notes.txt"), "Loop fallback");
  symlinkSync(skillDir, linkedSkillDir, "dir");
  symlinkSync(join(loopDir, "SKILL.md"), join(loopDir, "SKILL.md"));

  try {
    const expandHint = ` (${keyText("app.tools.expand")} to expand)`;
    const cases = [
      {
        name: "SKILL.md inside a real directory omits : SKILL.md",
        cwd: root,
        path: "skills/to-artifact/SKILL.md",
        source: "---\nname: to-artifact\n---\nBody",
        expectedCall: `[skill] to-artifact${expandHint}`,
        expectedExpandedResult: `to-artifact\n\nReferences are relative to ${skillDir}.\n\nBody`,
        isBox: true,
      },
      {
        name: "cwd at skill directory root resolves SKILL.md",
        cwd: skillDir,
        path: "SKILL.md",
        source: "---\nname: to-artifact\n---\nBody",
        expectedCall: `[skill] to-artifact${expandHint}`,
        expectedExpandedResult: `to-artifact\n\nReferences are relative to ${skillDir}.\n\nBody`,
        isBox: true,
      },
      {
        name: "cwd inside skill subdirectory resolves supplementary file",
        cwd: refsDir,
        path: "jira.md",
        source: "# Jira Template",
        expectedCall: `[skill] to-artifact: references/jira.md${expandHint}`,
        expectedExpandedResult: "# Jira Template",
        isBox: true,
      },
      {
        name: "symlinked skill directory resolves supplementary file",
        cwd: root,
        path: "skills/linked-artifact/references/jira.md",
        source: "# Jira Template",
        expectedCall: `[skill] linked-artifact: references/jira.md${expandHint}`,
        expectedExpandedResult: "# Jira Template",
        isBox: true,
      },
      {
        name: "cyclic SKILL.md symlink (ELOOP) falls back cleanly without throwing",
        cwd: root,
        path: "skills/loop-skill/notes.txt",
        source: "Loop fallback",
        expectedCall: "● Read(skills/loop-skill/notes.txt)",
        expectedCollapsedResult: "└ 1 line",
        expectedExpandedResult: "Loop fallback",
        isBox: false,
      },
    ];

    for (const row of cases) {
      const args = { path: row.path };
      const callComponent = read.renderCall!(args, theme, { ...context(args), cwd: row.cwd });
      assert.equal(text(callComponent), row.expectedCall, `${row.name} (call)`);
      assert.equal(callComponent instanceof Box, row.isBox, `${row.name} (call box)`);

      if (row.expectedCollapsedResult !== undefined) {
        const collapsedComponent = read.renderResult!(
          { content: [{ type: "text" as const, text: row.source }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { ...context(args, false), cwd: row.cwd },
        );
        assert.equal(text(collapsedComponent), row.expectedCollapsedResult, `${row.name} (collapsed)`);
        assert.equal(collapsedComponent instanceof Box, false, `${row.name} (collapsed box)`);
      }

      const expandedComponent = read.renderResult!(
        { content: [{ type: "text" as const, text: row.source }], details: undefined },
        { expanded: true, isPartial: false },
        theme,
        { ...context(args, true), cwd: row.cwd },
      );
      assert.equal(text(expandedComponent), row.expectedExpandedResult, `${row.name} (expanded)`);
      assert.equal(expandedComponent instanceof Box, row.isBox, `${row.name} (expanded box)`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outputPad = 1 aligns non-Box skill results with ordinary reads without double-padding Box cards", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-gear-skill-pad-"));
  const skillDir = join(root, "skills", "to-artifact");
  const refsDir = join(skillDir, "references");
  const outsideDir = join(root, "outside");
  mkdirSync(refsDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: to-artifact\n---\nBody");
  writeFileSync(join(refsDir, "jira.md"), "# Jira Template");
  writeFileSync(join(outsideDir, "notes.txt"), "Line 1\nLine 2");

  const register = (outputPad: number) => registerFileToolUi({
    getSettings: () => ({ outputPad }),
    registerTool: () => {},
  } as unknown as ExtensionAPI, root);
  register(1);

  try {
    const expandHint = ` (${keyText("app.tools.expand")} to expand)`;
    const cases: {
      name: string;
      render: () => Component;
      isBox: boolean;
      expectedLines: string[];
    }[] = [
      {
        name: "ordinary read call",
        render: () => read.renderCall!({ path: "outside/notes.txt" }, theme, { ...context({ path: "outside/notes.txt" }), cwd: root }),
        isBox: false,
        expectedLines: [" ● Read(outside/notes.txt)"],
      },
      {
        name: "ordinary read collapsed result",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "Line 1\nLine 2" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { ...context({ path: "outside/notes.txt" }), cwd: root },
        ),
        isBox: false,
        expectedLines: ["   └ 2 lines"],
      },
      {
        name: "ordinary read collapsed error",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "First failure\nSecond failure" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { ...context({ path: "outside/notes.txt" }), cwd: root, isError: true },
        ),
        isBox: false,
        expectedLines: ["   └ First failure"],
      },
      {
        name: "ordinary read expanded error",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "First failure\nSecond failure" }], details: undefined },
          { expanded: true, isPartial: false },
          theme,
          { ...context({ path: "outside/notes.txt" }, true), cwd: root, isError: true },
        ),
        isBox: false,
        expectedLines: ["   First failure", "   Second failure"],
      },
      {
        name: "supplementary file collapsed partial result",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "# Jira Template" }], details: { truncation: { truncated: true, outputLines: 1 } } },
          { expanded: false, isPartial: false },
          theme,
          { ...context({ path: "skills/to-artifact/references/jira.md" }), cwd: root },
        ),
        isBox: false,
        expectedLines: ["   └ Partial file · expand to view read limits"],
      },
      {
        name: "supplementary file collapsed error",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "First failure\nSecond failure" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { ...context({ path: "skills/to-artifact/references/jira.md" }), cwd: root, isError: true },
        ),
        isBox: false,
        expectedLines: ["   └ First failure"],
      },
      {
        name: "supplementary file expanded error",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "First failure\nSecond failure" }], details: undefined },
          { expanded: true, isPartial: false },
          theme,
          { ...context({ path: "skills/to-artifact/references/jira.md" }, true), cwd: root, isError: true },
        ),
        isBox: false,
        expectedLines: ["   First failure", "   Second failure"],
      },
      {
        name: "SKILL.md collapsed partial result",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "Body" }], details: { truncation: { truncated: true, outputLines: 1 } } },
          { expanded: false, isPartial: false },
          theme,
          { ...context({ path: "skills/to-artifact/SKILL.md" }), cwd: root },
        ),
        isBox: false,
        expectedLines: ["   └ Partial skill · expand to view read limits"],
      },
      {
        name: "SKILL.md collapsed error",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "First failure\nSecond failure" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { ...context({ path: "skills/to-artifact/SKILL.md" }), cwd: root, isError: true },
        ),
        isBox: false,
        expectedLines: ["   └ First failure"],
      },
      {
        name: "supplementary file Box call does not double-pad",
        render: () => read.renderCall!(
          { path: "skills/to-artifact/references/jira.md" },
          theme,
          { ...context({ path: "skills/to-artifact/references/jira.md" }), cwd: root },
        ),
        isBox: true,
        expectedLines: [` [skill] to-artifact: references/jira.md${expandHint}`],
      },
      {
        name: "supplementary file Box expanded result does not double-pad",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "# Jira Template" }], details: undefined },
          { expanded: true, isPartial: false },
          theme,
          { ...context({ path: "skills/to-artifact/references/jira.md" }, true), cwd: root },
        ),
        isBox: true,
        expectedLines: [" # Jira Template"],
      },
      {
        name: "SKILL.md Box call does not double-pad",
        render: () => read.renderCall!(
          { path: "skills/to-artifact/SKILL.md" },
          theme,
          { ...context({ path: "skills/to-artifact/SKILL.md" }), cwd: root },
        ),
        isBox: true,
        expectedLines: [` [skill] to-artifact${expandHint}`],
      },
      {
        name: "SKILL.md Box expanded result does not double-pad",
        render: () => read.renderResult!(
          { content: [{ type: "text" as const, text: "Body" }], details: undefined },
          { expanded: true, isPartial: false },
          theme,
          { ...context({ path: "skills/to-artifact/SKILL.md" }, true), cwd: root },
        ),
        isBox: true,
        expectedLines: [" to-artifact", ` References are relative to ${skillDir}.`, " Body"],
      },
    ];

    for (const row of cases) {
      const component = row.render();
      assert.equal(component instanceof Box, row.isBox, row.name);
      const renderedLines = component
        .render(120)
        .map((line) => stripVTControlCharacters(line).trimEnd())
        .filter((line) => line.trim() !== "");
      assert.deepEqual(renderedLines, row.expectedLines, row.name);
      if (row.isBox) {
        for (const line of renderedLines) {
          assert.ok(line.startsWith(" ") && !line.startsWith("  "), `${row.name}: unexpected Box padding`);
        }
      }
    }
  } finally {
    register(0);
    rmSync(root, { recursive: true, force: true });
  }
});
