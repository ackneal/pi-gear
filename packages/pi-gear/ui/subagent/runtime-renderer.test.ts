import assert from "node:assert/strict";
import test from "node:test";
import { TaskController, type TaskRecord } from "pi-rostrix";
import { researcherProfile } from "../../subagents/agents/researcher/index.ts";
import { renderSubagentResult } from "./renderer.ts";
import { SubagentResultComponent } from "./component.ts";
import { clearSubagentRegistry, recordSubagentLiveStart } from "./registry.ts";
import type { TaskSnapshot } from "../../subagents/runtime/types.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

for (const source of ["initial", "saved", "live"] as const) {
  test(`${source} taskId snapshot preserves source precedence`, (t) => {
    clearSubagentRegistry();
    t.after(clearSubagentRegistry);
    const taskId = "task-history";
    const details: TaskSnapshot & { taskId: string } = {
      taskId, status: "success", startedAt: 1000, finishedAt: 2000, activities: [], result: "Initial answer",
    };
    if (source === "live") {
      recordSubagentLiveStart("distinct-tool-call", "Inspect", { ...details, result: "Live answer" });
    }
    const savedIds: string[] = [];
    const component = renderSubagentResult(researcherProfile, { content: [], details },
      { expanded: true, isPartial: false }, theme,
      { toolCallId: "distinct-tool-call", invalidate() {} }, undefined,
      (id) => {
        savedIds.push(id);
        return source === "initial" ? undefined : { ...details, result: "Saved answer" };
      });
    t.after(() => (component as SubagentResultComponent).dispose());

    const output = component.render(180).join("\n");
    const expected = { initial: "Initial answer", saved: "Saved answer", live: "Live answer" }[source];
    assert.match(output, new RegExp(expected));
    for (const other of ["Initial answer", "Saved answer", "Live answer"].filter((answer) => answer !== expected)) {
      assert.ok(!output.includes(other));
    }
    assert.deepEqual(savedIds, source === "live" ? [] : [taskId]);
  });
}

for (const source of ["snapshot", "subscription"] as const) {
  for (const expanded of [false, true]) {
    test(`runtime ${source} preserves activity, usage and duration (expanded=${expanded})`, (t) => {
      clearSubagentRegistry();
      t.after(clearSubagentRegistry);
      const record: TaskRecord = {
        id: "task-evidence", agentId: "researcher", task: "Inspect",
        depth: 0, targetFiles: [], wakeOn: [], status: "completed", revision: 5,
        createdAt: 1000, startedAt: 1000, lastActivityAt: 3000, finishedAt: 3000,
        result: "Verified answer", activitiesTruncated: true,
        activities: [
          { kind: "message", role: "assistant", text: "Not an activity row" },
          { kind: "tool", id: "tool-1", name: "read", args: { path: "evidence.txt" }, status: "success", result: "Evidence" },
        ],
        usage: { input: 1000, output: 200, cacheRead: 500, cost: { total: 0.02 } },
      };
      const tasks = new TaskController();
      let listener: ((task: TaskRecord) => void) | undefined;
      t.mock.method(tasks, "getTask", (taskId: string) => {
        assert.equal(taskId, record.id);
        return source === "snapshot" ? record : {
          ...record, status: "running", activities: [], usage: undefined, finishedAt: undefined,
        };
      });
      t.mock.method(tasks, "subscribe", (taskId: string, callback: (task: TaskRecord) => void) => {
        assert.equal(taskId, record.id);
        listener = callback;
        return () => { listener = undefined; };
      });

      const component = renderSubagentResult(researcherProfile, {
        content: [], details: { status: "running", startedAt: 1000, activities: [], ...{ taskId: record.id } },
      }, { expanded, isPartial: false }, theme, {
        toolCallId: "distinct-tool-call", args: { question: "Inspect" }, invalidate() {},
      }, { tasks });
      t.after(() => (component as SubagentResultComponent).dispose());
      if (source === "subscription") {
        assert.ok(listener, "must bind to the authoritative task registry");
        listener(record);
      }

      const output = component.render(180).join("\n");
      assert.match(output, /1\/1 tools/);
      assert.match(output, /↑1\.5k ↓200 · \$0\.020 · 2s/);
      assert.doesNotMatch(output, /aborted|Not an activity row/);
      if (expanded) {
        assert.match(output, /Read · success · evidence\.txt/);
        assert.match(output, /Earlier activity omitted/);
        assert.match(output, /Verified answer/);
      }
    });
  }
}
