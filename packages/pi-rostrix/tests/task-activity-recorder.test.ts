import assert from "node:assert/strict";
import test from "node:test";
import type { AgentSessionEvent, AgentToolResult } from "@earendil-works/pi-coding-agent";
import { TaskController } from "../src/tasks/controller.ts";
import type { TaskActivity } from "../src/tasks/types.ts";
import { agent, assistant } from "./runtime-fixtures.ts";

const message = assistant({ content: [{ type: "thinking", thinking: "Plan" }] });
const start: AgentSessionEvent = { type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: { path: "file.ts" } };
const partialResult: AgentToolResult<undefined> = { content: [{ type: "text", text: "partial" }], details: undefined };
const result: AgentToolResult<{ lines: number }> = { content: [{ type: "text", text: "done" }], details: { lines: 1 } };
const circularDetails: { self?: unknown } = {};
circularDetails.self = circularDetails;
const cases: { name: string; events: AgentSessionEvent[]; expected: TaskActivity[]; truncated?: boolean; toolsTruncated?: boolean }[] = [
  {
    name: "tool start preserves args and running state",
    events: [start],
    expected: [{ kind: "tool", id: "call-1", name: "read", args: { path: "file.ts" }, status: "running" }],
  },
  ...([false, true] as const).map((isError) => ({
    name: `tool completion records ${isError ? "error" : "success"} and final result`,
    events: [start,
      { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "updated.ts" }, partialResult },
      { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result, isError },
    ] satisfies AgentSessionEvent[],
    expected: [{ kind: "tool", id: "call-1", name: "read", args: { path: "updated.ts" }, status: isError ? "error" : "success", result: JSON.stringify(result) }] satisfies TaskActivity[],
  })),
  {
    name: "tool update is visible before completion",
    events: [start, { type: "tool_execution_update", toolCallId: "call-1", toolName: "read", args: { path: "file.ts" }, partialResult }],
    expected: [{ kind: "tool", id: "call-1", name: "read", args: { path: "file.ts" }, status: "running", result: JSON.stringify(partialResult) }],
  },
  {
    name: "thinking deltas reconcile with final snapshot without duplication",
    events: [
      { type: "message_start", message },
      { type: "message_update", message, assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: message } },
      { type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Pl", partial: message } },
      { type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "an", partial: message } },
      { type: "message_update", message, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Plan", partial: message } },
      { type: "message_end", message },
      { type: "message_start", message },
      { type: "message_end", message },
    ],
    expected: [
      { kind: "thinking", messageId: 1, contentIndex: 0, text: "Plan" },
      { kind: "thinking", messageId: 2, contentIndex: 0, text: "Plan" },
    ],
  },
  {
    name: "thinking remains visible before message end",
    events: [{ type: "message_update", message, assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Plan", partial: message } }],
    expected: [{ kind: "thinking", messageId: 0, contentIndex: 0, text: "Plan" }],
  },
  {
    name: "history keeps only the latest 100 activities",
    events: Array.from({ length: 105 }, (_, index) => ({ ...start, toolCallId: String(index) })),
    expected: Array.from({ length: 100 }, (_, index) => ({ kind: "tool", id: String(index + 5), name: "read", args: { path: "file.ts" }, status: "running" })),
    truncated: true,
    toolsTruncated: true,
  },
  {
    name: "non-JSON tool details do not break event delivery",
    events: [start, { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: { content: [], details: circularDetails }, isError: false }],
    expected: [{ kind: "tool", id: "call-1", name: "read", args: { path: "file.ts" }, status: "success", result: JSON.stringify({ error: "Unserializable tool event payload" }) }],
    truncated: true,
  },
  {
    name: "large thinking is bounded",
    events: [{ type: "message_end", message: assistant({ content: [{ type: "thinking", thinking: "x".repeat(20_000) }] }) }],
    expected: [{ kind: "thinking", messageId: 0, contentIndex: 0, text: "x".repeat(16_384) }],
    truncated: true,
  },
  {
    name: "large tool args and results are bounded",
    events: [{ ...start, args: { data: "x".repeat(20_000) } }, { type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: "y".repeat(20_000), isError: false }],
    expected: [{ kind: "tool", id: "call-1", name: "read", args: { truncated: JSON.stringify({ data: "x".repeat(20_000) }).slice(0, 16_384) }, status: "success", result: JSON.stringify("y".repeat(20_000)).slice(0, 16_384) }],
    truncated: true,
  },
];

test("registry records bounded SDK events and live usage", async (t) => {
  for (const row of cases) {
    await t.test(row.name, async () => {
      const usage = { inputTokens: 11, outputTokens: 7, cacheReadTokens: 5, cacheWriteTokens: 3, totalTokens: 26, cost: 0.37 };
      const expectedUsage = { input: 11, output: 7, cacheRead: 5, cacheWrite: 3, totalTokens: 26, cost: { total: 0.37 } };
      const registry = new TaskController({
        createRunner: (options) => ({
          run: async () => {
            await Promise.resolve();
            for (const event of row.events) options.onEvent?.(event);
            options.onUsage?.(usage);
            const running = registry.listTasks()[0]!;
            assert.equal(running.status, "running");
            assert.deepEqual(running.activities, row.expected);
            assert.deepEqual(running.usage, expectedUsage);
            return { status: "completed", usage, turns: 1, durationMs: 1 };
          },
        }),
      });
      const task = registry.spawn({ agent: agent(), task: "Work" });
      const finished = await registry.wait(task.id);
      assert.equal(finished.status, "completed", finished.error ?? "Task must complete");
      assert.deepEqual(finished.activities, row.expected);
      assert.deepEqual(finished.usage, expectedUsage);
      assert.equal(finished.activitiesTruncated ?? false, row.truncated ?? false);
      assert.equal(finished.toolActivitiesTruncated ?? false, row.toolsTruncated ?? false);
      assert.ok(finished.revision > 1);
    });
  }
});
