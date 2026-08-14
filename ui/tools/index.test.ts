import assert from "node:assert/strict";
import test from "node:test";
import { createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, initTheme } from "@earendil-works/pi-coding-agent";
import { createSandboxBashTool, registerFileToolUi } from "./index.ts";
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
