import assert from "node:assert/strict";
import test from "node:test";
import type { BackgroundSnapshot } from "./background.ts";
import { compactSubagentOutput, subagentControlResult } from "./output.ts";

function snapshot(status: BackgroundSnapshot["status"]): BackgroundSnapshot {
  return {
    runId: "run-1",
    status,
    revision: 4,
    profile: "worker",
    task: "large task metadata",
    dispatch: { model: "provider/model" },
    startedAt: 1,
    updatedAt: 2,
    expiry: 3,
    idleSeconds: 5,
    noProgressSeconds: 7,
    activeTools: status === "running" ? ["bash"] : [],
    toolCalls: 2,
    toolErrors: 1,
    consecutiveToolErrors: 1,
    latestUpdate: "bash: running",
    partialResult: "useful partial",
    usage: { input: 100, output: 20 },
    run: {
      status: status === "cancelling" ? "running" : status,
      startedAt: 1,
      items: [{ kind: "tool", id: "large", name: "bash", status: "running", result: "large retained output" }],
      result: "final result",
      error: "child failed",
      usage: { input: 100, output: 20 },
    },
  };
}

test("running observe output is compact and excludes retained runtime state", () => {
  const output = compactSubagentOutput(snapshot("running"), "changed");
  assert.deepEqual(output, {
    reason: "changed",
    runId: "run-1",
    status: "running",
    revision: 4,
    idleSeconds: 5,
    noProgressSeconds: 7,
    activeTools: ["bash"],
    toolCalls: 2,
    toolErrors: 1,
    consecutiveToolErrors: 1,
    latestUpdate: "bash: running",
  });
  const text = JSON.stringify(output);
  assert.doesNotMatch(text, /items|usage|large task metadata|provider\/model|large retained output/);
});

test("terminal observe output includes only the useful terminal payload", () => {
  const success = compactSubagentOutput(snapshot("success"), "terminal");
  assert.equal(success.result, "final result");
  assert.equal(success.partialResult, undefined);
  assert.equal(success.error, undefined);

  for (const status of ["error", "aborted"] as const) {
    const failed = compactSubagentOutput(snapshot(status), "terminal");
    assert.equal(failed.result, undefined, status);
    assert.equal(failed.partialResult, "useful partial", status);
    assert.equal(failed.error, "child failed", status);
  }
});

test("control-tool results keep compact details without full runtime state", () => {
  const base = snapshot("success");
  const result = subagentControlResult(base, "terminal");
  assert.deepEqual(result.details, compactSubagentOutput(base, "terminal"));

  const text = JSON.stringify(result);
  assert.doesNotMatch(text, /"items"|"task"|"dispatch"|large retained output/);
  assert.equal(result.content[0]?.type, "text");
});
