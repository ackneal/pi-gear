import { configureOutputPadding } from "./padding.ts";
configureOutputPadding({ getSettings: () => ({ outputPad: 0 }) });
import assert from "node:assert/strict";
import test from "node:test";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { createSandboxBashTool, executionResult, getCustomToolDefinition, lspToolRenderers, registerFileToolUi, workspaceToolRenderers } from "./index.ts";
import * as PiTui from "@earendil-works/pi-tui";

initTheme();
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const { visibleWidth } = PiTui as unknown as { visibleWidth(text: string): number };

function context<T extends Record<string, unknown>>(args: T, expanded = false) {
  return {
    args,
    cwd: "/workspace",
    expanded,
    isError: false,
    lastComponent: undefined,
    state: {},
    executionStarted: false,
    invalidate: () => undefined,
    argsComplete: true,
    isPartial: false,
    showImages: true,
    toolCallId: "test",
  };
}

test("read can expand after a collapsed result", () => {
  const tool = getCustomToolDefinition("read", "/workspace")!;
  const result = { content: [{ type: "text" as const, text: "first\nsecond" }], details: undefined };
  const collapsed = tool.renderResult!(result, { expanded: false, isPartial: false }, theme, context({ path: "a.ts" }));
  const expanded = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, {
    ...context({ path: "a.ts" }, true), lastComponent: collapsed,
  });
  assert.match(renderedText(expanded), /first[\s\S]*second/);
});

test("collapsed bash selects one final nonempty line from progress output", () => {
  const cases = [
    { text: "first\nlast\n\n", expected: "last" },
    { text: "first\r\nlast\r\n", expected: "last" },
    { text: "Rebasing (1/4)\rRebasing (2/4)\rSuccessfully rebased.\r\n", expected: "Successfully rebased." },
    { text: "progress\r\u001b[32mCompleted\u001b[0m\r  \n", expected: "Completed" },
    { text: "\r\n  \r", expected: undefined },
  ];
  for (const { text, expected } of cases) {
    const result = executionResult({})({ content: [{ type: "text", text }], details: undefined },
      { expanded: false, isPartial: false }, theme, context({ command: "demo" }));
    assert.deepEqual(renderedLines(result, 100), expected ? [`  └ ${expected}`] : [], JSON.stringify(text));
  }
});

test("collapsed final bash result clears native streaming interval", () => {
  const interval = setInterval(() => {}, 1000);
  const state: Record<string, unknown> = { interval, startedAt: Date.now() };
  try {
    executionResult({})({ content: [], details: undefined }, { expanded: false, isPartial: false }, theme, {
      ...context({ command: "echo done" }), state,
    });
    assert.equal(state.interval, undefined);
    assert.equal(typeof state.endedAt, "number");
  } finally {
    clearInterval(interval);
  }
});

function assertFits(component: { render(width: number): string[] }, width: number): void {
  assert.ok(component.render(width).every((line) => visibleWidth(line) <= Math.max(1, width)));
}

function renderedLines(component: { render(width: number): string[] }, width: number): string[] {
  return component.render(width).map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ""));
}

function renderedText(component: { render(width: number): string[] }, width = 200): string {
  return renderedLines(component, width).map((line) => line.trimEnd()).join("\n");
}

function lspResult(kind: "diagnostics" | "navigation", args: Record<string, unknown>, details: unknown, expanded: boolean) {
  const renderers = lspToolRenderers(kind);
  return renderers.renderResult!(
    { content: [], details } as never,
    { expanded, isPartial: false },
    theme,
    context(args, expanded),
  );
}

test("custom tool components truncate adversarial lines at the supplied terminal width", () => {
  const registered = new Map<string, any>();
  registerFileToolUi({ getSettings: () => ({ outputPad: 0 }), registerTool: (tool: any) => registered.set(tool.name, tool) } as never, "/workspace");
  const long = "確認長文字顯示正常".repeat(20);
  const read = registered.get("read") as ReturnType<typeof createReadToolDefinition>;
  const write = registered.get("write") as ReturnType<typeof createWriteToolDefinition>;
  const bash = createSandboxBashTool("/workspace", { exec: async () => ({ exitCode: 0 }) });

  assertFits(read.renderCall!({ path: long }, theme, context({ path: long })), 92);
  assertFits(write.renderCall!({ path: long, content: `\x1b[31m${long}\x1b[0m` }, theme, context({ path: long, content: long }, true)), 92);
  assertFits(bash.renderCall!({ command: "x".repeat(200) }, theme, context({ command: "x".repeat(200) })), 92);
});

test("detail bodies wrap without losing diagnostics or source tails", () => {
  const registered = new Map<string, any>();
  registerFileToolUi({ getSettings: () => ({ outputPad: 0 }), registerTool: (tool: any) => registered.set(tool.name, tool) } as never, "/workspace");
  const edit = registered.get("edit") as ReturnType<typeof createEditToolDefinition>;
  const write = registered.get("write") as ReturnType<typeof createWriteToolDefinition>;
  const long = "確認長文字顯示正常".repeat(20);
  const error = `Could not find exact text: ${long} END_DIAGNOSTIC`;
  const errorContext = context({ path: "src/index.ts" }) as unknown as { isError: boolean };
  errorContext.isError = true;
  const editError = edit.renderResult!({ content: [{ type: "text", text: error }] } as never, { expanded: true, isPartial: false }, theme, errorContext as never);
  const diff = `-${long}\n+${long} DIFF_TAIL`;
  const editDiff = edit.renderResult!({ content: [], details: { diff } } as never, { expanded: true, isPartial: false }, theme, context({ path: "src/index.ts", edits: [{ oldText: long, newText: `${long} DIFF_TAIL` }] }, true));
  const writeBody = `const value = "${long}"; // WRITE_TAIL`;
  const writeCall = write.renderCall!({ path: "src/example.ts", content: writeBody }, theme, context({ path: "src/example.ts", content: writeBody }, true));

  for (const component of [editError, editDiff, writeCall]) assertFits(component, 92);
  assert.match(renderedLines(editError, 92).join("\n"), /END_DIAGNOSTIC/);
  assert.match(renderedLines(editDiff, 92).join("\n"), /DIFF_TAIL/);
  assert.match(renderedLines(writeCall, 92).join("\n"), /WRITE_TAIL/);
  assert.doesNotMatch(renderedLines(editError, 92).join("\n"), /…/);
  assert.doesNotMatch(renderedLines(writeCall, 92).slice(1).join("\n"), /…/);
});

test("headers remain a single ellipsized line", () => {
  const registered = new Map<string, any>();
  registerFileToolUi({ getSettings: () => ({ outputPad: 0 }), registerTool: (tool: any) => registered.set(tool.name, tool) } as never, "/workspace");
  const read = registered.get("read") as ReturnType<typeof createReadToolDefinition>;
  const header = read.renderCall!({ path: `src/${"x".repeat(200)}.ts` }, theme, context({ path: `src/${"x".repeat(200)}.ts` }));
  const output = renderedLines(header, 92);

  assertFits(header, 92);
  assert.equal(output.length, 1);
  assert.match(output[0] ?? "", /…/);
});

test("workspace find and grep use the project tool UI", () => {
  for (const kind of ["find", "grep"] as const) {
    const renderers = workspaceToolRenderers(kind);
    const args = { path: "src", pattern: "needle" };
    const call = renderedText(renderers.renderCall!(args as never, theme, context(args)));
    const collapsed = renderedText(renderers.renderResult!({ content: [{ type: "text", text: "src/file.ts" }] } as never, { expanded: false, isPartial: false }, theme, context(args)));
    const expanded = renderedText(renderers.renderResult!({ content: [{ type: "text", text: "src/file.ts" }] } as never, { expanded: true, isPartial: false }, theme, context(args, true)));

    assert.equal(call, `● ${kind === "find" ? "Find" : "Grep"}(src · needle)`);
    assert.equal(collapsed, "  └ 1 result");
    assert.match(expanded, /^\n  src\/file\.ts/);
  }
});

test("LSP diagnostics use terminal empty state and collapsible complete results", () => {
  const emptyCollapsed = renderedText(lspResult("diagnostics", {}, { diagnostics: [] }, false));
  const emptyExpanded = renderedText(lspResult("diagnostics", {}, { diagnostics: [] }, true));
  assert.equal(emptyCollapsed, emptyExpanded);
  assert.match(emptyCollapsed, /^● Diagnostics\n  └ no issues$/);
  assert.doesNotMatch(emptyCollapsed, /^[+-]/);
  assert.equal(
    renderedText(lspResult("diagnostics", { scope: "changed" }, { diagnostics: [] }, false)),
    emptyCollapsed,
  );
  assert.match(
    renderedText(lspResult("diagnostics", { scope: "workspace" }, { diagnostics: [] }, false)),
    /^● Diagnostics\(workspace\)\n  └ no issues$/,
  );

  const diagnostics = [
    { path: "src/a.rs", line: 12, column: 5, endLine: 12, endColumn: 6, severity: "error", source: "rust-analyzer", code: "E0308", message: "mismatched types" },
    { path: "src/b.rs", line: 30, column: 9, endLine: 30, endColumn: 10, severity: "warning", message: "unused variable `x`" },
    { path: "src/c.rs", line: 18, column: 3, endLine: 18, endColumn: 4, severity: "information", message: "information detail" },
    { path: "src/d.rs", line: 20, column: 7, endLine: 20, endColumn: 8, severity: "hint", message: "hint detail" },
  ];
  const collapsed = renderedText(lspResult("diagnostics", {}, { diagnostics }, false));
  const changed = renderedText(lspResult("diagnostics", { scope: "changed" }, { diagnostics }, false));
  const workspaceCollapsed = renderedText(lspResult("diagnostics", { scope: "workspace" }, { diagnostics }, false));
  const workspaceExpanded = renderedText(lspResult("diagnostics", { scope: "workspace" }, { diagnostics }, true));

  assert.match(collapsed, /^● Diagnostics\n  └ 1 error · 1 warning · 2 suggestions$/);
  assert.equal(changed, collapsed);
  assert.doesNotMatch(changed, /changed/);
  assert.doesNotMatch(collapsed, /mismatched types/);
  assert.match(workspaceCollapsed, /^● Diagnostics\(workspace\)\n  └ 1 error · 1 warning · 2 suggestions$/);
  assert.match(workspaceExpanded, /^● Diagnostics\(workspace\)\n  └ 1 error · 1 warning · 2 suggestions/m);
  for (const expected of [
    "src/a.rs:12:5 [error rust-analyzer E0308] mismatched types",
    "src/b.rs:30:9 [warning] unused variable `x`",
    "src/c.rs:18:3 [information] information detail",
    "src/d.rs:20:7 [hint] hint detail",
  ]) assert.match(workspaceExpanded, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("partial LSP navigation uses a neutral label until action is available", () => {
  const renderers = lspToolRenderers("navigation");
  const partialContext = context({}) as unknown as { isPartial: boolean };
  partialContext.isPartial = true;

  const partial = renderers.renderCall!({}, theme, partialContext as never);

  assert.match(renderedText(partial), /^· Navigation$/);
});

test("LSP navigation renders action labels, result states, complete locations, and plurals", () => {
  const cases = [
    { action: "definition", empty: "● Definition\n  └ no result", one: "● Definition\n  └ 1 location" },
    { action: "references", empty: "● References\n  └ no results", one: "● References\n  └ 1 location" },
  ] as const;

  for (const { action, empty, one } of cases) {
    const emptyCollapsed = renderedText(lspResult("navigation", { action }, { locations: [] }, false));
    const emptyExpanded = renderedText(lspResult("navigation", { action }, { locations: [] }, true));
    assert.equal(emptyCollapsed, emptyExpanded, action);
    assert.equal(emptyCollapsed, empty, action);
    assert.doesNotMatch(emptyCollapsed, /navigation/, action);

    const oneLocation = [{ path: "src/foo.ts", line: 42, column: 5 }];
    const oneCollapsed = renderedText(lspResult("navigation", { action }, { locations: oneLocation }, false));
    assert.equal(oneCollapsed, one, action);

    const locations = [...oneLocation, { path: "src/bar.ts", line: 18, column: 3 }];
    const collapsed = renderedText(lspResult("navigation", { action }, { locations }, false));
    const expanded = renderedText(lspResult("navigation", { action }, { locations }, true));
    assert.match(collapsed, new RegExp(`^● ${action === "definition" ? "Definition" : "References"}\n  └ 2 locations$`), action);
    assert.match(expanded, new RegExp(`^● ${action === "definition" ? "Definition" : "References"}\n  └ 2 locations`), action);
    assert.match(expanded, /src\/foo\.ts:42:5/, action);
    assert.match(expanded, /src\/bar\.ts:18:3/, action);
    assert.doesNotMatch(expanded, /navigation/, action);
  }
});


test("file and execution headers use bold title-case labels", () => {
  const registered = new Map<string, any>();
  registerFileToolUi({ getSettings: () => ({ outputPad: 0 }), registerTool: (tool: any) => registered.set(tool.name, tool) } as never, "/workspace");
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => `<bold>${text}</bold>` } as never;
  const bash = createSandboxBashTool("/workspace", { exec: async () => ({ exitCode: 0 }) });
  const cases = [
    { tool: registered.get("read"), args: { path: "src/a.ts", offset: 2, limit: 3 }, expanded: false, expected: ["● <bold>Read</bold>(src/a.ts:2-4)"] },
    { tool: registered.get("edit"), args: { path: "src/a.ts" }, expanded: true, expected: ["● <bold>Edit</bold>(src/a.ts)"] },
    { tool: registered.get("write"), args: { path: "src/a.ts" }, expanded: false, expected: ["● <bold>Write</bold>(src/a.ts)"] },
    { tool: bash, args: { command: "echo hello" }, expanded: false, expected: ["● <bold>Bash</bold>(echo hello)"] },
    { tool: bash, args: { command: "echo hello" }, expanded: true, expected: ["● <bold>Bash</bold>", "  echo hello"] },
  ];

  for (const { tool, args, expanded, expected } of cases) {
    const component = tool.renderCall!(args, plainTheme, context(args, expanded));
    assert.deepEqual(renderedLines(component, 200), expected);
  }
});

 test("expanded bash discloses full commands and indents native results", () => {
  for (const outputPad of [0, 1] as const) {
    configureOutputPadding({ getSettings: () => ({ outputPad }) });
    try {
      const tool = getCustomToolDefinition("bash", "/workspace")!;
      const command = "x".repeat(211) + "\necho tail";
      const ctx = { ...context({ command }, true), state: { startedAt: Date.now() } };
      const call = tool.renderCall!({ command }, theme, ctx);
      for (const width of [20, 40, 80]) {
        const lines = call.render(width);
        assert.ok(lines.at(-1)?.trim(), "command must not add a blank row before the native result spacer");
        assert.ok(lines.every(line => visibleWidth(line) <= width));
        assert.equal(lines.slice(1).map(line => line.trim()).join(""), command.replace(/\n/g, ""));
        assert.ok(lines.slice(1).filter(line => line.trim()).every(line => line.startsWith(" ".repeat(outputPad + 2))));
      }
      let previous: unknown;
      for (let i = 0; i < 2; i++) {
        const result = tool.renderResult!({ content: [{ type: "text", text: "first\nsecond" }], details: { fullOutputPath: "/tmp/output" } }, { expanded: true, isPartial: false }, theme, { ...ctx, lastComponent: previous } as never);
        assert.ok(result instanceof PiTui.Container);
        if (previous) assert.equal(result, previous);
        const lines = result.render(40).map(line => line.replace(/\x1b\[[0-9;]*m/g, ""));
        assert.ok(lines.filter(line => line.trim()).every(line => line.startsWith(" ".repeat(outputPad + 2))));
        assert.match(lines.join("\n"), /Took/);
        assert.match(lines.join("\n"), /Full output/);
        previous = result;
      }
    } finally {
      configureOutputPadding({ getSettings: () => ({ outputPad: 0 }) });
    }
  }
});
