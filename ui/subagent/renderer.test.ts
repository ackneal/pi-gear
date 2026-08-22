import assert from "node:assert/strict";
import test from "node:test";
import {
  collapsed,
  formatCost,
  formatDuration,
  formatTokens,
  formatUsage,
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

test("collapsed includes idle indication when stalled", () => {
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
});

test("formatTokens formats token counts according to threshold rules", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(500), "500");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_000), "1.0k");
  assert.equal(formatTokens(1_234), "1.2k");
  assert.equal(formatTokens(9_940), "9.9k");
  assert.equal(formatTokens(10_000), "10k");
  assert.equal(formatTokens(456_789), "457k");
  assert.equal(formatTokens(999_999), "1000k");
  assert.equal(formatTokens(1_000_000), "1.0M");
  assert.equal(formatTokens(2_500_000), "2.5M");
});

test("formatCost formats dollar amounts according to threshold rules", () => {
  assert.equal(formatCost(0), "$0.000");
  assert.equal(formatCost(-0.5), "$0.000");
  assert.equal(formatCost(0.002), "$0.002");
  assert.equal(formatCost(0.05), "$0.050");
  assert.equal(formatCost(0.999), "$0.999");
  assert.equal(formatCost(1.0), "$1.00");
  assert.equal(formatCost(1.5), "$1.50");
  assert.equal(formatCost(12.3456), "$12.35");
});

test("formatUsage formats input, cache, output, and cost", () => {
  assert.equal(formatUsage(undefined), undefined);

  const usage = {
    input: 1_000,
    output: 450,
    cacheRead: 200,
    cacheWrite: 50,
    cost: { total: 0.002 },
  };
  // inTokens = 1000 + 200 + 50 = 1250 -> 1.3k (or 1.25 -> 1.3k)
  // outTokens = 450 -> 450
  // totalCost = 0.002 -> $0.002
  assert.equal(formatUsage(usage), "↑1.3k ↓450 · $0.002");
});

test("collapsed metadata renders tool fraction and usage accurately", () => {
  // Successful tools
  const runWithSuccessTools = {
    status: "success" as const,
    startedAt: 0,
    finishedAt: 2_000,
    items: [
      { kind: "tool" as const, id: "t1", name: "read", status: "success" as const },
      { kind: "tool" as const, id: "t2", name: "bash", status: "success" as const },
    ],
  };
  const collapsedSuccess = collapsed(runWithSuccessTools, researcher, theme, "✓", 2_000);
  assert.match(collapsedSuccess, /2\/2 tools · 2s/);

  // Failed tools
  const runWithFailedTools = {
    status: "success" as const,
    startedAt: 0,
    finishedAt: 3_000,
    items: [
      { kind: "tool" as const, id: "t1", name: "read", status: "success" as const },
      { kind: "tool" as const, id: "t2", name: "bash", status: "error" as const },
      { kind: "tool" as const, id: "t3", name: "edit", status: "success" as const },
    ],
  };
  const collapsedFailed = collapsed(runWithFailedTools, researcher, theme, "✓", 3_000);
  assert.match(collapsedFailed, /2\/3 tools · 1 failed · 3s/);

  // With usage
  const runWithUsage = {
    ...runWithSuccessTools,
    usage: {
      input: 1_200,
      output: 450,
      cost: { total: 0.002 },
    },
  };
  const collapsedUsage = collapsed(runWithUsage, researcher, theme, "✓", 2_000);
  assert.match(collapsedUsage, /2\/2 tools · ↑1.2k ↓450 · \$0\.002 · 2s/);
});

