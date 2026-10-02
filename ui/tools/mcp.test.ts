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

for (const { name, texts, expected } of [
  { name: "SGR styling", texts: ["\x1b[31mred\x1b[0m"], expected: "red" },
  { name: "colon-separated SGR", texts: ["\x1b[38:2::255:0:0mRGB\x1b[0m"], expected: "RGB" },
  { name: "cursor and erase sequences", texts: ["one\x1b[2J\x1b[3A two"], expected: "one two" },
  { name: "OSC hyperlinks", texts: ["\x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\"], expected: "link" },
  { name: "OSC title with BEL", texts: ["\x1b]0;hidden title\x07visible"], expected: "visible" },
  { name: "OSC title with C1 terminator", texts: ["\x1b]0;hidden title\u009cvisible"], expected: "visible" },
  { name: "C1 CSI styling", texts: ["\u009b31mred\u009b0m"], expected: "red" },
  { name: "binary controls", texts: ["a\x00\x01\x02\x03\x04\x05\x06\x07\x08\x0b\x0c\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1fb"], expected: "ab" },
  { name: "interlinear annotations and Unicode", texts: ["你好\ufff9🙂\ufffaé\ufffb"], expected: "你好🙂é" },
  { name: "CR removal and tab expansion", texts: ["one\r\n\nnext\tword\rlast"], expected: "one\n\nnext   wordlast" },
  { name: "multiple text blocks", texts: ["\x1b[31mone\x1b[0m", "\x00two"], expected: "one\ntwo" },
  { name: "control-only output", texts: ["\x00\ufff9\x1b[0m\r"], expected: "" },
]) {
  for (const expanded of [false, true]) {
    for (const isError of [false, true]) {
      test(`MCP result sanitizes ${name}: ${expanded ? "expanded" : "collapsed"}, ${isError ? "error" : "success"}`, () => {
        const styledLines: { color: string; text: string }[] = [];
        const recordingTheme = { ...theme, fg: (color: string, text: string) => {
          styledLines.push({ color, text });
          return text;
        } };

        const component = renderer().renderResult(
          { content: texts.map((text) => ({ type: "text", text })), details: {} },
          { expanded }, recordingTheme, { isError, showImages: false },
        );

        assert.deepEqual(styledLines, expected ? expected.split("\n").map((text) => ({
          color: isError ? "error" : "toolOutput", text,
        })) : []);
        assert.equal(component.render(120).map((line) => line.trimEnd()).join("\n"), expected ? `\n${expected}` : "");
      });
    }
  }
}

for (const { name, text, expected } of [
  { name: "image-only output", text: "", expected: "[Image: [image/png]]" },
  { name: "sanitized text with image", text: "\x1b[31mcaption\x1b[0m\x00", expected: "caption\n[Image: [image/png]]" },
]) {
  for (const expanded of [false, true]) {
    test(`MCP result preserves ${name}: ${expanded ? "expanded" : "collapsed"}`, () => {
      const component = renderer().renderResult(
        { content: [{ type: "text", text }, { type: "image", data: "", mimeType: "image/png" }], details: {} },
        { expanded }, theme, { isError: false, showImages: false },
      );
      assert.equal(component.render(120).map((line) => line.trimEnd()).join("\n"), `\n${expected}`);
    });
  }
}
