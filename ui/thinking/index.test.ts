import assert from "node:assert/strict";
import test from "node:test";
import { formatThinking, HIDDEN_THINKING_LABEL } from "./index.ts";

test("thinking formatting removes only an explicit leading label", () => {
  const cases = [
    { input: "thinking: First paragraph\n\nSecond", expected: "First paragraph\n\nSecond" },
    { input: " Thinking: thinking: Ready", expected: "Ready" },
    { input: "- first\n- second\n", expected: "- first\n- second\n" },
    { input: "thinking: ```ts\nconst x = 1;\n```", expected: "```ts\nconst x = 1;\n```" },
    { input: "    indented code\n\n", expected: "    indented code\n\n" },
    { input: "✦ Original\n\n✦ Another", expected: "✦ Original\n\n✦ Another" },
    { input: "# Heading\n\n> Quote\n\nthinking: body", expected: "# Heading\n\n> Quote\n\nthinking: body" },
    { input: "thinking:\n    code\n", expected: "\n    code\n" },
    { input: "", expected: "" },
    { input: " \n", expected: " \n" },
  ];
  for (const { input, expected } of cases) {
    assert.equal(formatThinking(input), expected, JSON.stringify(input));
  }
  assert.equal(HIDDEN_THINKING_LABEL, "✦ Thought");
});
