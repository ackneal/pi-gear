import assert from "node:assert/strict";
import test from "node:test";
import { truncateHead, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { registerFileToolUi } from "./index.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;

test("read summaries count file lines rather than continuation notices", () => {
  let read: ToolDefinition | undefined;
  registerFileToolUi({
    getSettings: () => ({ outputPad: 0 }),
    registerTool: (tool: ToolDefinition) => { if (tool.name === "read") read = tool; },
  } as unknown as ExtensionAPI, "/workspace");
  const twelve = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n");
  const cases = [
    { name: "plain content", text: twelve, expected: 12 },
    { name: "user limit footer", text: `${twelve}\n\n[202 more lines in file. Use offset=13 to continue.]`, expected: 12 },
    { name: "actual trailing blank line", text: "first\n\n\n[2 more lines in file. Use offset=3 to continue.]", expected: 2 },
    { name: "truncation metadata", text: "a\nb\n\n[Showing lines 1-2 of 100. Use offset=3 to continue.]", details: { truncation: truncateHead("a\nb\nc", { maxLines: 2 }) }, expected: 2 },
    { name: "line exceeds byte limit", text: "[Line 1 exceeds limit]", details: { truncation: truncateHead("oversized line", { maxBytes: 1 }) }, expected: 0 },
  ];
  for (const row of cases) {
    const component = read!.renderResult!({ content: [{ type: "text", text: row.text }], details: row.details }, { expanded: false, isPartial: false }, theme, {
      args: { path: "file.ts", limit: 12 }, cwd: "/workspace", expanded: false, isError: false,
      lastComponent: undefined, state: {}, executionStarted: true, invalidate: () => {},
      argsComplete: true, isPartial: false, showImages: false, toolCallId: row.name,
    });
    assert.equal(component.render(100).join("\n").trim(), `└ ${row.expected} lines`, row.name);
  }
});
