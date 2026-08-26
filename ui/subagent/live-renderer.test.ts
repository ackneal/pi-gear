import assert from "node:assert/strict";
import test from "node:test";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { researcherProfile } from "../../subagents/agents/researcher/index.ts";
import type { SubagentRun } from "../../subagents/runtime/types.ts";
import { clearSubagentRegistry, recordSubagentLiveStart, recordSubagentLiveUpdate } from "./detail/index.ts";
import { SubagentResultComponent } from "./component.ts";
import { renderSubagentResult } from "./renderer.ts";
import type { Theme } from "./format.ts";

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

function rendered(component: { render(width: number): string[] }): string {
  return component.render(100).join("\n");
}

test("asynchronous transcript component follows live registry updates through completion", () => {
  clearSubagentRegistry();
  const initial: SubagentRun = { status: "running", startedAt: Date.now(), items: [] };
  recordSubagentLiveStart("async-call", researcherProfile, "Inspect", initial);
  let invalidations = 0;

  const component = renderSubagentResult(
    researcherProfile,
    { content: [{ type: "text", text: "started" }], details: { ...initial, runId: "run-1" } } as AgentToolResult<SubagentRun>,
    { isPartial: false, expanded: false } as never,
    theme,
    { toolCallId: "async-call", args: { question: "Inspect" }, invalidate: () => { invalidations++; } },
  );
  assert.match(rendered(component), /Researching/);

  recordSubagentLiveUpdate("async-call", {
    ...initial,
    items: [{ kind: "tool", id: "read-1", name: "read", status: "running" }],
  });
  assert.match(rendered(component), /Read running/);
  assert.equal(invalidations, 1);

  recordSubagentLiveUpdate("async-call", {
    ...initial,
    status: "success",
    finishedAt: Date.now(),
    result: "Done",
    items: [{ kind: "tool", id: "read-1", name: "read", status: "success" }],
  });
  assert.match(rendered(component), /Research complete/);
  assert.equal(invalidations, 2);
  assert.ok(component instanceof SubagentResultComponent);
  component.dispose();
});

test("partial transcript rendering remains driven by normal partial results", () => {
  const running: SubagentRun = { status: "running", startedAt: Date.now(), items: [{ kind: "thinking", text: "Checking" }] };
  const component = renderSubagentResult(
    researcherProfile,
    { content: [{ type: "text", text: "Checking" }], details: running } as AgentToolResult<SubagentRun>,
    { isPartial: true, expanded: false } as never,
    theme,
    { toolCallId: "foreground-call", args: { question: "Inspect" }, invalidate: () => {} },
  );

  assert.match(rendered(component), /Checking/);
  assert.ok(component instanceof SubagentResultComponent);
  component.dispose();
});
