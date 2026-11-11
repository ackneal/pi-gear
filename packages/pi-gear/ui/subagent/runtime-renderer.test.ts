import assert from "node:assert/strict";
import test from "node:test";
import { TaskRegistry, type TaskRecord } from "pi-rostrix";
import { researcherProfile } from "../../subagents/agents/researcher/index.ts";
import { renderSubagentResult } from "./renderer.ts";
import { SubagentResultComponent } from "./component.ts";
import { clearSubagentRegistry } from "./registry.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

for (const source of ["snapshot", "subscription"] as const) {
  for (const expanded of [false, true]) {
    test(`runtime ${source} preserves activity, usage and duration (expanded=${expanded})`, (t) => {
      clearSubagentRegistry();
      t.after(clearSubagentRegistry);
      const record: TaskRecord = {
        id: "task-evidence", agentId: "researcher", profileId: "researcher", task: "Inspect",
        depth: 0, targetFiles: [], wakeOn: [], status: "completed", revision: 5,
        createdAt: 1000, startedAt: 1000, lastActivityAt: 3000, finishedAt: 3000,
        result: "Verified answer", itemsTruncated: true,
        items: [
          { kind: "message", role: "assistant", text: "Not an activity row" },
          { kind: "tool", id: "tool-1", name: "read", args: { path: "evidence.txt" }, status: "success", result: "Evidence" },
        ],
        usage: { input: 1000, output: 200, cacheRead: 500, cost: { total: 0.02 } },
      };
      const tasks = new TaskRegistry();
      let listener: ((task: TaskRecord) => void) | undefined;
      t.mock.method(tasks, "getTask", () => source === "snapshot" ? record : {
        ...record, status: "running", items: [], usage: undefined, finishedAt: undefined,
      });
      t.mock.method(tasks, "subscribe", (_id: string, callback: (task: TaskRecord) => void) => {
        listener = callback;
        return () => { listener = undefined; };
      });

      const component = renderSubagentResult(researcherProfile, {
        content: [], details: { status: "running", startedAt: 1000, items: [], ...{ runId: record.id } },
      }, { expanded, isPartial: false }, theme, {
        args: { question: "Inspect" }, invalidate() {},
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
