import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { MAX_RETAINED_ITEMS } from "./limits.ts";
import { runChildSubagent } from "./runner.ts";
import type { SubagentRun } from "./types.ts";

for (const count of [MAX_RETAINED_ITEMS, MAX_RETAINED_ITEMS + 1]) {
  for (const exitCode of [0, 1]) {
    test(`runner snapshots preserve truncation with ${count} items and exit ${exitCode}`, async () => {
      const updates: SubagentRun[] = [];
      const events = Array.from({ length: count }, (_, i) => i % 2 === 0
        ? { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: String(i) }] } }
        : { type: "tool_execution_start", toolCallId: String(i), toolName: "tool" });
      // Distinct messages keep thinking blocks from replacing prior retained blocks.
      const lines: unknown[] = events.flatMap((event) => [{ type: "message_start" }, event]);
      lines.push({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      const output = lines.map((event) => JSON.stringify(event)).join("\n") + "\n";
      const result = await runChildSubagent({
        task: "test",
        profile: { id: "test", label: "Test", description: "Test", systemPrompt: "Test", capabilities: [] },
        childExtension: new URL("./protocol.test.ts", import.meta.url),
        spawnChild: () => spawn(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(output)}, () => process.exit(${exitCode}))`]),
        onUpdate: (run) => updates.push(run),
      });
      assert.equal(result.status, exitCode === 0 ? "success" : "error");
      assert.equal(result.itemsTruncated, count > MAX_RETAINED_ITEMS ? true : undefined);
      assert.equal(result.items.length, MAX_RETAINED_ITEMS);
      assert.deepEqual(updates.at(-1), result);
      assert.notEqual(updates.at(-1), result);
      assert.equal(updates[0]?.itemsTruncated, undefined);
      assert.equal(updates[0]?.items.length, 1);
    });
  }
}
