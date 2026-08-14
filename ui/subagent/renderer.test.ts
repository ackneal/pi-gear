import assert from "node:assert/strict";
import test from "node:test";
import { expanded, type SubagentRendererProfile, type Theme } from "./format.ts";
import { Spinner } from "./spinner.ts";

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };
const researcher: SubagentRendererProfile = {
  id: "researcher",
  label: "researcher",
  presentation: { activity: { starting: "Researching", complete: "Research complete", drafting: "Drafting research", failed: "Research failed", aborted: "Research aborted" } },
};
test("spinner invalidates while running, stops for terminal state, and disposes cleanly", () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timer = {} as ReturnType<typeof setInterval>;
  let tick: (() => void) | undefined;
  let starts = 0;
  let clears = 0;
  let invalidations = 0;
  let frames = 0;

  globalThis.setInterval = ((callback: () => void) => {
    starts += 1;
    tick = callback;
    return timer;
  }) as typeof setInterval;
  globalThis.clearInterval = (() => { clears += 1; }) as typeof clearInterval;

  try {
    const spinner = new Spinner(() => { invalidations += 1; frames += 1; });
    spinner.start();
    assert.equal(starts, 1);
    tick?.();
    assert.equal(invalidations, 1);
    assert.equal(frames, 1);

    spinner.stop();
    assert.equal(clears, 1);

    spinner.start();
    assert.equal(starts, 2);
    spinner.dispose();
    assert.equal(clears, 2);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
});

test("expanded output keeps ordered, readable, sanitized subagent details", () => {
  const output = expanded({
    status: "success",
    startedAt: 0,
    finishedAt: 1_000,
    items: [
      { kind: "thinking", text: "Thinking: inspect call_secret_123" },
      { kind: "tool", id: "tool_1", name: "mcp__exa__search", status: "success", result: '{"result":{"summary":"Exa finding"},"toolCallId":"call_hidden"}' },
      { kind: "tool", id: "tool_2", name: "mcp__context7__query", status: "success", result: "Context finding" },
      { kind: "tool", id: "tool_3", name: "mcp__gh_grep__search", status: "error", result: "GitHub finding" },
    ],
    result: "Final report",
  }, researcher, theme);

  const thinking = output.indexOf("inspect");
  const exa = output.indexOf("✓ Exa");
  const context7 = output.indexOf("✓ Context7");
  const github = output.indexOf("✗ GitHub grep");
  const result = output.indexOf("╰ Result");
  assert.ok(thinking < exa && exa < context7 && context7 < github && github < result);
  assert.match(output, /Exa finding/);
  assert.doesNotMatch(output, /Thinking:|call_secret_123|call_hidden|tool_1|\{"result"/);
});
