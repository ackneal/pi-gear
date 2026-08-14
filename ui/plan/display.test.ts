import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeDisplayText, visibleWidth, wrapDisplayText } from "./display.ts";
import { createPlanWidget } from "./widget.ts";

test("sanitized widget content stays one actual terminal line", () => {
  const factory = createPlanWidget({ kind: "steady", state: { goal: "Goal", todos: [{ id: 1, text: "確認\n\t\x1b[31m長文字顯示正常\x1b[0m", doneWhen: "Done", status: "in_progress" }], constraints: [], findings: [] } });
  const lines = factory(undefined, { fg: (_color: string, text: string) => text, bold: (text: string) => text }).render(24);
  assert.equal(lines.length, 1);
  assert.ok(visibleWidth(lines[0] ?? "") <= 24);
  assert.doesNotMatch(sanitizeDisplayText(lines[0] ?? ""), /[\r\n\t\x1b]/);
});

test("display wrapping preserves indentation while splitting unbroken CJK text", () => {
  const lines = wrapDisplayText("確認長文字顯示正常並且在非常窄的終端視窗中仍然保持清楚可讀", "    ● ", "      ", 20);
  assert.ok(lines.length > 1);
  assert.ok(lines.every((line) => visibleWidth(line) <= 20));
  assert.match(lines[0] ?? "", /^    ● /);
  assert.match(lines[1] ?? "", /^      /);
});
