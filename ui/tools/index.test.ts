import assert from "node:assert/strict";
import test from "node:test";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { createSandboxBashTool, lspToolRenderers, registerFileToolUi } from "./index.ts";
import * as PiTui from "@earendil-works/pi-tui";

initTheme();
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;
const { visibleWidth } = PiTui as unknown as { visibleWidth(text: string): number };

function context(args: Record<string, unknown>, expanded = false) {
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
  } as never;
}

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
  registerFileToolUi({ registerTool: (tool: any) => registered.set(tool.name, tool) } as never, "/workspace");
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
  registerFileToolUi({ registerTool: (tool: any) => registered.set(tool.name, tool) } as never, "/workspace");
  const edit = registered.get("edit") as ReturnType<typeof createEditToolDefinition>;
  const write = registered.get("write") as ReturnType<typeof createWriteToolDefinition>;
  const long = "確認長文字顯示正常".repeat(20);
  const error = `Could not find exact text: ${long} END_DIAGNOSTIC`;
  const errorContext = context({ path: "src/index.ts" }) as unknown as { isError: boolean };
  errorContext.isError = true;
  const editError = edit.renderResult!({ content: [{ type: "text", text: error }] } as never, { expanded: false, isPartial: false }, theme, errorContext as never);
  const diff = `-${long}\n+${long} DIFF_TAIL`;
  const editDiff = edit.renderResult!({ content: [], details: { diff } } as never, { expanded: true, isPartial: false }, theme, context({ path: "src/index.ts" }, true));
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
  registerFileToolUi({ registerTool: (tool: any) => registered.set(tool.name, tool) } as never, "/workspace");
  const read = registered.get("read") as ReturnType<typeof createReadToolDefinition>;
  const header = read.renderCall!({ path: `src/${"x".repeat(200)}.ts` }, theme, context({ path: `src/${"x".repeat(200)}.ts` }));
  const output = renderedLines(header, 92);

  assertFits(header, 92);
  assert.equal(output.length, 1);
  assert.match(output[0] ?? "", /…/);
});

test("LSP diagnostics use terminal empty state and collapsible complete results", () => {
  const emptyCollapsed = renderedText(lspResult("diagnostics", {}, { diagnostics: [] }, false));
  const emptyExpanded = renderedText(lspResult("diagnostics", {}, { diagnostics: [] }, true));
  assert.equal(emptyCollapsed, emptyExpanded);
  assert.match(emptyCollapsed, /^✓ DIAGNOSTICS\s*$/);
  assert.doesNotMatch(emptyCollapsed, /^[+-]/);

  const diagnostics = [
    { path: "src/a.rs", line: 12, column: 5, endLine: 12, endColumn: 6, severity: "error", source: "rust-analyzer", code: "E0308", message: "mismatched types" },
    { path: "src/b.rs", line: 30, column: 9, endLine: 30, endColumn: 10, severity: "warning", message: "unused variable `x`" },
    { path: "src/c.rs", line: 18, column: 3, endLine: 18, endColumn: 4, severity: "information", message: "information detail" },
    { path: "src/d.rs", line: 20, column: 7, endLine: 20, endColumn: 8, severity: "hint", message: "hint detail" },
  ];
  const collapsed = renderedText(lspResult("diagnostics", {}, { diagnostics }, false));
  const expanded = renderedText(lspResult("diagnostics", {}, { diagnostics }, true));

  assert.match(collapsed, /^\+ DIAGNOSTICS\s+1 error · 1 warning · 2 suggestions$/);
  assert.doesNotMatch(collapsed, /mismatched types/);
  assert.match(expanded, /^- DIAGNOSTICS\s+1 error · 1 warning · 2 suggestions/m);
  for (const expected of [
    "src/a.rs:12:5 [error rust-analyzer E0308] mismatched types",
    "src/b.rs:30:9 [warning] unused variable `x`",
    "src/c.rs:18:3 [information] information detail",
    "src/d.rs:20:7 [hint] hint detail",
  ]) assert.match(expanded, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("partial LSP navigation uses a neutral label until action is available", () => {
  const renderers = lspToolRenderers("navigation");
  const partialContext = context({}) as unknown as { isPartial: boolean };
  partialContext.isPartial = true;

  const partial = renderers.renderCall!({}, theme, partialContext as never);

  assert.match(renderedText(partial), /^\+ NAVIGATION\s*$/);
});

test("LSP navigation renders action labels, result states, complete locations, and plurals", () => {
  const cases = [
    { action: "definition", empty: "✓ DEFINITION       no result", one: "+ DEFINITION       1 location" },
    { action: "references", empty: "✓ REFERENCES       no results", one: "+ REFERENCES       1 location" },
  ] as const;

  for (const { action, empty, one } of cases) {
    const emptyCollapsed = renderedText(lspResult("navigation", { action }, { locations: [] }, false));
    const emptyExpanded = renderedText(lspResult("navigation", { action }, { locations: [] }, true));
    assert.equal(emptyCollapsed, emptyExpanded, action);
    assert.equal(emptyCollapsed, empty, action);
    assert.doesNotMatch(emptyCollapsed, /NAVIGATION/, action);

    const oneLocation = [{ path: "src/foo.ts", line: 42, column: 5 }];
    const oneCollapsed = renderedText(lspResult("navigation", { action }, { locations: oneLocation }, false));
    assert.equal(oneCollapsed, one, action);

    const locations = [...oneLocation, { path: "src/bar.ts", line: 18, column: 3 }];
    const collapsed = renderedText(lspResult("navigation", { action }, { locations }, false));
    const expanded = renderedText(lspResult("navigation", { action }, { locations }, true));
    assert.match(collapsed, new RegExp(`^\\+ ${action.toUpperCase()}\\s+2 locations$`), action);
    assert.match(expanded, new RegExp(`^- ${action.toUpperCase()}\\s+2 locations`), action);
    assert.match(expanded, /src\/foo\.ts:42:5/, action);
    assert.match(expanded, /src\/bar\.ts:18:3/, action);
    assert.doesNotMatch(expanded, /NAVIGATION/, action);
  }
});
