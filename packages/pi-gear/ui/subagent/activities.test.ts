import assert from "node:assert/strict";
import test from "node:test";
import { normalizeRunActivities } from "../../subagents/activities.ts";
import { toTaskSnapshot } from "../../subagents/task-snapshot.ts";
import { researcherProfile } from "../../subagents/agents/researcher/index.ts";
import type { TaskSnapshot } from "../../subagents/runtime/types.ts";
import { renderSubagentResult } from "./renderer.ts";
import { SubagentResultComponent } from "./component.ts";

const history = [{ kind: "tool" as const, name: "read", status: "success" as const }];
const metadata = { status: "success" as const, startedAt: 1, finishedAt: 2, taskId: "saved-task", modelSelection: { model: "test" }, usage: { input: 1, output: 2 }, result: "Answer" };

for (const { name, fields, activities, truncated } of [
  { name: "legacy", fields: { items: history, itemsTruncated: true }, activities: history, truncated: true },
  { name: "current", fields: { activities: history, activitiesTruncated: true }, activities: history, truncated: true },
  { name: "both prefer explicit empty and false", fields: { items: history, itemsTruncated: true, activities: [], activitiesTruncated: false }, activities: [], truncated: false },
  { name: "invalid new fields fall back", fields: { items: history, itemsTruncated: true, activities: null, activitiesTruncated: "invalid" }, activities: history, truncated: true },
  { name: "new history wins", fields: { items: [], itemsTruncated: false, activities: history, activitiesTruncated: true }, activities: history, truncated: true },
  { name: "missing", fields: {}, activities: [], truncated: undefined },
  { name: "undefined", fields: { activities: undefined, items: undefined }, activities: [], truncated: undefined },
  { name: "null", fields: { activities: null, items: null }, activities: [], truncated: undefined },
  { name: "non-array", fields: { activities: {}, items: "invalid", itemsTruncated: "invalid" }, activities: [], truncated: undefined },
  { name: "malformed new entries fall back", fields: { activities: [null], items: history }, activities: history, truncated: undefined },
  ...[null, "invalid", {}, { kind: "thinking", text: null }, { kind: "thinking", text: "Text", contentIndex: "invalid" },
    { kind: "tool", name: null, status: "success" }, { kind: "tool", name: "read", status: "invalid" },
    { kind: "tool", name: "read", status: "success", args: null }, { kind: "tool", name: "read", status: "success", args: [] },
    { kind: "tool", name: "read", status: "success", result: 42 },
  ].flatMap((invalid, index) => [
    { name: `malformed legacy activity ${index}`, fields: { items: [invalid] }, activities: [], truncated: undefined },
    { name: `malformed current activity ${index}`, fields: { activities: [invalid] }, activities: [], truncated: undefined },
  ]),
]) {
  test(`normalizeRunActivities: ${name} preserves metadata without legacy keys`, () => {
    const input = { ...metadata, ...fields };
    const original = structuredClone(input);
    const normalized = normalizeRunActivities(input);
    assert.deepEqual(normalized, { ...metadata, activities, ...(truncated === undefined ? {} : { activitiesTruncated: truncated }) });
    assert.equal("items" in normalized, false);
    assert.equal("itemsTruncated" in normalized, false);
    assert.deepEqual(input, original);
  });
}

for (const legacy of [false, true]) {
  test(`saved ${legacy ? "legacy" : "current"} tool-result details render history and flags`, (t) => {
    const details = { ...metadata, ...(legacy ? { items: history, itemsTruncated: true } : { activities: history, activitiesTruncated: true }) };
    const original = structuredClone(details);
    const component = renderSubagentResult(researcherProfile,
      { content: [], details: details as TaskSnapshot },
      { expanded: true, isPartial: false },
      { fg: (_color, text) => text, bold: (text) => text },
      { invalidate() {} });
    t.after(() => (component as SubagentResultComponent).dispose());
    const output = component.render(80).join("\n");
    assert.match(output, /Read · success/);
    assert.match(output, /Earlier tool activity omitted/);
    assert.match(output, /Answer/);
    assert.deepEqual(details, original);
  });
}

test("normalizeRunActivities validates toolActivitiesTruncated as boolean", () => {
  const valid = normalizeRunActivities({ ...metadata, activities: history, toolActivitiesTruncated: false });
  assert.equal(valid.toolActivitiesTruncated, false);

  const invalid = normalizeRunActivities({ ...metadata, activities: history, toolActivitiesTruncated: "invalid" });
  assert.equal("toolActivitiesTruncated" in invalid, false);
});

test("toTaskSnapshot sets toolActivitiesTruncated to false when only activitiesTruncated is true", () => {
  const base = {
    id: "t-1", agentId: "researcher", task: "Inspect", depth: 0, targetFiles: [], wakeOn: [],
    status: "completed" as const, revision: 1, createdAt: 1, lastActivityAt: 2, activities: [],
  };
  assert.equal(toTaskSnapshot({ ...base, activitiesTruncated: true }).toolActivitiesTruncated, false);
  assert.equal(toTaskSnapshot({ ...base, activitiesTruncated: true, toolActivitiesTruncated: true }).toolActivitiesTruncated, true);
  assert.equal(toTaskSnapshot(base).toolActivitiesTruncated, undefined);
});
