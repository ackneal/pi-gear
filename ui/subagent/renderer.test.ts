import assert from "node:assert/strict";
import test from "node:test";
import {
  collapsed,
  expanded,
  formatDuration,
  idleDuration,
  STALLED_THRESHOLD_MS,
  type SubagentRendererProfile,
  type Theme,
} from "./format.ts";
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

test("formatDuration and idleDuration handle units and running state", () => {
  assert.equal(STALLED_THRESHOLD_MS, 15_000);
  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(4_500), "4.5s");
  assert.equal(formatDuration(15_000), "15s");
  assert.equal(formatDuration(65_000), "1m 05s");

  const runningRun = {
    status: "running" as const,
    startedAt: 10_000,
    lastActivityAt: 20_000,
    items: [],
  };
  assert.equal(idleDuration(runningRun, 35_000), 15_000);
  assert.equal(idleDuration({ status: "running", startedAt: 10_000, items: [] }, 25_000), 15_000);

  const finishedRun = {
    status: "success" as const,
    startedAt: 10_000,
    finishedAt: 30_000,
    items: [],
  };
  assert.equal(idleDuration(finishedRun, 50_000), 0);
  assert.equal(idleDuration(undefined, 50_000), 0);
});

test("collapsed and expanded include idle indication when stalled", () => {
  const stalledRun = {
    status: "running" as const,
    startedAt: 0,
    lastActivityAt: 5_000,
    items: [{ kind: "tool" as const, id: "t1", name: "read", status: "running" as const }],
  };

  const activeCollapsed = collapsed(stalledRun, researcher, theme, "●", 10_000);
  assert.doesNotMatch(activeCollapsed, /idle/);

  const stalledCollapsed = collapsed(stalledRun, researcher, theme, "●", 25_000);
  assert.match(stalledCollapsed, /· idle 20s/);

  const activeExpanded = expanded(stalledRun, researcher, theme, "●", 10_000);
  assert.doesNotMatch(activeExpanded, /No activity for/);
  assert.doesNotMatch(activeExpanded, /╰ Result/);

  const stalledExpanded = expanded(stalledRun, researcher, theme, "●", 25_000);
  assert.match(stalledExpanded, /│ No activity for 20s/);
  assert.doesNotMatch(stalledExpanded, /╰ Result/);

  const completedExpanded = expanded({
    ...stalledRun,
    status: "success",
    finishedAt: 30_000,
    result: "Done",
  }, researcher, theme, "✓", 35_000);
  assert.doesNotMatch(completedExpanded, /No activity for/);
  assert.match(completedExpanded, /╰ Result/);
  assert.match(completedExpanded, /Done/);
});
