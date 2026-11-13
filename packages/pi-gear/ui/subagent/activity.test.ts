import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { TaskSnapshot } from "../../subagents/runtime/types.ts";
import { expandedActivity } from "./activity.ts";
import type { Theme } from "./format.ts";

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

for (const status of ["running", "success", "error", "aborted"] as const) {
  test(`activity retains all starts and projects safe rows for ${status}`, () => {
    const run: TaskSnapshot & { activitiesTruncated: boolean } = {
      status, startedAt: 0, activitiesTruncated: true,
      activities: [
        { kind: "thinking", text: "PRIVATE_THOUGHT" },
        ...Array.from({ length: 9 }, (_, index) => ({
          kind: "tool" as const, name: `read_${index}`, status: index === 0 ? "running" as const : index === 1 ? "error" as const : "success" as const,
          args: { command: `echo\n\u001b[31m${index}\t${"界".repeat(80)}`, secret: "PRIVATE_ARGUMENT" }, result: "PRIVATE_RESULT",
        })),
      ],
    };
    for (const width of [1, 8, 40, 300]) {
      const output = expandedActivity(run, theme, width);
      const rows = output.split("\n").slice(4);
      assert.equal(rows.length, 9);
      assert.ok(rows.every((row) => visibleWidth(row) <= width));
      assert.doesNotMatch(output, /PRIVATE|\u001b\[31m|\t/);
      if (width === 300) {
        assert.match(output, /Earlier activity omitted/);
        assert.match(rows[0]!, status === "running" ? /running/ : /interrupted/);
        assert.match(rows[1]!, /error/);
        assert.match(rows[2]!, /success/);
        rows.forEach((row, index) => assert.match(row, new RegExp(`Read ${index} ·`)));
      }
    }
  });
}

for (const activities of [[], [{ kind: "thinking" as const, text: "private" }]]) {
  test(`empty tool activity is hidden (${activities.length} activities)`, () => {
    assert.equal(expandedActivity({ status: "success", startedAt: 0, activities }, theme, 80), "");
  });
}
