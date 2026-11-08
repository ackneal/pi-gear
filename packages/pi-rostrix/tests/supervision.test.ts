import assert from "node:assert/strict";
import test from "node:test";
import { ParentInbox } from "../src/supervision/inbox.ts";
import { WakeUpManager } from "../src/supervision/wake-up.ts";

test("ParentInbox coalesces multiple notifications within debounce window", async () => {
  const delivered: string[] = [];
  const inbox = new ParentInbox({
    debounceMs: 50,
    onDeliver: (msg) => {
      delivered.push(msg);
    },
  });

  inbox.enqueue({
    taskId: "task-1",
    profileId: "worker",
    status: "completed",
    result: "Finished step 1",
    timestamp: Date.now(),
  });

  inbox.enqueue({
    taskId: "task-2",
    profileId: "reviewer",
    status: "completed",
    result: "Review passed",
    timestamp: Date.now(),
  });

  assert.equal(delivered.length, 0);

  // Wait for debounce flush
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(delivered.length, 1);
  const first = delivered[0]!;
  assert.ok(first.includes('task_id="task-1"'));
  assert.ok(first.includes('task_id="task-2"'));
  assert.ok(first.includes("Review passed"));
});

test("WakeUpManager wakes parent when idle and queues when busy", async () => {
  const messages: string[] = [];
  const mockPi: any = {
    on: () => {},
    sendUserMessage: async (msg: string) => {
      messages.push(msg);
    },
  };

  const inbox = new ParentInbox({ debounceMs: 10 });
  const wakeUp = new WakeUpManager(inbox, mockPi);

  // When idle, delivers immediately
  wakeUp.setParentIdle(true);
  await wakeUp.deliverOrQueue("Wake up 1");
  assert.deepEqual(messages, ["Wake up 1"]);

  // When busy, queues message
  wakeUp.setParentIdle(false);
  await wakeUp.deliverOrQueue("Queued message 1");
  await wakeUp.deliverOrQueue("Queued message 2");
  assert.equal(messages.length, 1);

  // Setting parent idle flushes the queued messages
  wakeUp.setParentIdle(true);
  assert.equal(messages.length, 2);
  const second = messages[1]!;
  assert.ok(second.includes("Queued message 1"));
  assert.ok(second.includes("Queued message 2"));
});
