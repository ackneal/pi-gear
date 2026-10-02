import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { getCustomToolDefinition } from "./index.ts";

initTheme("dark", false);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
type TestTheme = typeof theme;
type Renderer = {
  renderCall(args: unknown, theme: TestTheme, context: unknown): Component;
  renderResult(result: unknown, options: unknown, theme: TestTheme, context: unknown): Component;
};

function renderer(): Renderer {
  const definition = getCustomToolDefinition("mcp__exa__web_search_exa");
  assert.ok(definition);
  return definition as unknown as Renderer;
}

for (const { name, args, expanded, expected } of [
  { name: "empty arguments", args: {}, expanded: false, expected: "exa/web_search_exa" },
  { name: "collapsed arguments", args: { query: "hello", limit: 3 }, expanded: false, expected: 'exa/web_search_exa query="hello" limit=3' },
  { name: "expanded arguments", args: { query: "hello\nworld", limit: 3 }, expanded: true, expected: "exa/web_search_exa\n  query: hello\n    world\n  limit: 3" },
  { name: "truncated arguments", args: { query: "x".repeat(150) }, expanded: false, expected: `exa/web_search_exa ${('query="' + 'x'.repeat(150) + '"').slice(0, 97)}...` },
]) {
  test(`MCP call uses native formatting: ${name}`, () => {
    const component = renderer().renderCall(args, theme, { expanded });
    assert.equal(component.render(240).map((line) => line.trimEnd()).join("\n"), expected);
  });
}

for (const { name, text, expanded, width, preview, hidden } of [
  { name: "collapsed logical lines", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven", expanded: false, width: 80, preview: "one\ntwo\nthree\nfour\nfive", hidden: 2 },
  { name: "collapsed wrapped lines", text: "x".repeat(70), expanded: false, width: 10, preview: Array(5).fill("x".repeat(10)).join("\n"), hidden: 2 },
  { name: "expanded output", text: "one\ntwo\nthree\nfour\nfive\nsix\nseven", expanded: true, width: 80, preview: "one\ntwo\nthree\nfour\nfive\nsix\nseven", hidden: 0 },
]) {
  test(`MCP result uses native preview: ${name}`, () => {
    const component = renderer().renderResult(
      { content: [{ type: "text", text }], details: {} },
      { expanded }, theme, { isError: false, showImages: false },
    );
    const output = component.render(width).map((line) => line.trimEnd()).join("\n");
    assert.ok(output.includes(preview), output);
    if (hidden) {
      assert.ok(output.includes(`... (${hidden} `), output);
      assert.equal(output.split("\n").filter((line) => line && !line.startsWith("...")).length, 5);
    } else {
      assert.doesNotMatch(output, /more lines/);
    }
  });
}

test("collapsed MCP results retain full-output path and error color", () => {
  const colors: string[] = [];
  const errorTheme = { ...theme, fg: (color: string, text: string) => { colors.push(color); return text; } };
  const component = renderer().renderResult(
    { content: [{ type: "text", text: "failed\trequest" }], details: { fullOutputPath: "/tmp/mcp-output.txt" } },
    { expanded: false }, errorTheme, { isError: true, showImages: false },
  );
  const output = component.render(80).join("\n");
  assert.match(output, /failed   request/);
  assert.match(output, /Full output: \/tmp\/mcp-output.txt/);
  assert.ok(colors.includes("error"));
});
