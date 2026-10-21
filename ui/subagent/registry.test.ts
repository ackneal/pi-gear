import assert from "node:assert/strict";
import test, { afterEach, beforeEach } from "node:test";
import type { SubagentRun } from "../../subagents/runtime/types.ts";
import {
  clearSubagentRegistry, getSubagentEntry,
  recordSubagentLiveStart, recordSubagentLiveUpdate, subscribeSubagent,
} from "./registry.ts";

const run = (result = ""): SubagentRun => ({
  status: "running", startedAt: 1, result,
  items: [{ kind: "tool", id: "read", name: "read", status: "success" }],
});

beforeEach(clearSubagentRegistry);
afterEach(clearSubagentRegistry);

for (const operation of ["start", "update"] as const) {
  test(`${operation} notifies every streamed report change with unchanged tool statuses`, () => {
    const initial = run("First");
    const next = run("First, then more");
    const received: SubagentRun[] = [];
    if (operation === "update") recordSubagentLiveStart("live", "Task", initial);
    subscribeSubagent("live", (value) => received.push(value));

    if (operation === "start") {
      recordSubagentLiveStart("live", "Task", initial);
      recordSubagentLiveStart("live", "Task", next);
    } else {
      recordSubagentLiveUpdate("live", initial);
      recordSubagentLiveUpdate("live", next);
    }

    assert.deepEqual(received, [initial, next]);
    assert.strictEqual(getSubagentEntry("live")?.run, next);
    assert.equal(getSubagentEntry("live")?.task, "Task");
    assert.deepEqual(getSubagentEntry("live"), { task: "Task", run: next });
  });
}

test("updates to nonexistent runs neither invent history nor notify", () => {
  const received: SubagentRun[] = [];
  subscribeSubagent("missing", (value) => received.push(value));

  recordSubagentLiveUpdate("missing", run("Late report"));

  assert.equal(getSubagentEntry("missing"), undefined);
  assert.deepEqual(received, []);
});

test("unsubscribe removes only its listener and is idempotent", () => {
  const removed: SubagentRun[] = [];
  const retained: SubagentRun[] = [];
  const unsubscribe = subscribeSubagent("live", (value) => removed.push(value));
  subscribeSubagent("live", (value) => retained.push(value));
  const initial = run();
  recordSubagentLiveStart("live", "Task", initial);

  unsubscribe();
  unsubscribe();
  const next = run("More");
  recordSubagentLiveUpdate("live", next);

  assert.deepEqual(removed, [initial]);
  assert.deepEqual(retained, [initial, next]);
});

test("clear removes entries and subscriptions and ignores late updates", () => {
  const received: SubagentRun[] = [];
  recordSubagentLiveStart("live", "Task", run());
  subscribeSubagent("live", (value) => received.push(value));

  clearSubagentRegistry();
  recordSubagentLiveUpdate("live", run("Late"));

  assert.equal(getSubagentEntry("live"), undefined);
  assert.deepEqual(received, []);

  recordSubagentLiveStart("live", "New task", run("New"));
  assert.deepEqual(received, []);
});

test("live start bounds retention at 50 and evicts the oldest entry and subscribers", () => {
    for (let index = 0; index < 50; index++) {
      recordSubagentLiveStart(`run-${index}`, `Task ${index}`, run());
    }
    const received: SubagentRun[] = [];
    subscribeSubagent("run-0", (value) => received.push(value));
    recordSubagentLiveUpdate("run-0", run("Updated"));
    recordSubagentLiveStart("run-1", "Restarted", run());
    received.length = 0;
    for (let index = 0; index < 50; index++) {
      assert.ok(getSubagentEntry(`run-${index}`));
    }

    recordSubagentLiveStart("run-50", "New task", run());

    for (let index = 1; index <= 50; index++) {
      assert.ok(getSubagentEntry(`run-${index}`));
    }
    assert.equal(getSubagentEntry("run-0"), undefined);
    recordSubagentLiveUpdate("run-0", run("Late"));
    assert.equal(getSubagentEntry("run-0"), undefined);
    recordSubagentLiveStart("run-0", "Restarted", run());
    assert.ok(getSubagentEntry("run-0"));
    for (let index = 2; index <= 50; index++) {
      assert.ok(getSubagentEntry(`run-${index}`));
    }
    assert.equal(getSubagentEntry("run-1"), undefined);
    assert.deepEqual(received, []);
  });
