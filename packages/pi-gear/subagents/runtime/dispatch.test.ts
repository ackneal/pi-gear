import assert from "node:assert/strict";
import test from "node:test";
import { formatSubagentDispatch } from "./dispatch.ts";

const cases = [
  { dispatch: undefined, expected: undefined },
  { dispatch: {}, expected: undefined },
  { dispatch: { model: "model" }, expected: "model" },
  { dispatch: { model: "provider/model", thinkingLevel: "low" as const }, expected: "(provider) model • low" },
  { dispatch: { model: "provider/org/model", thinkingLevel: "high" as const }, expected: "(provider) org/model • high" },
];

test("formats subagent dispatch metadata", () => {
  for (const { dispatch, expected } of cases) {
    assert.equal(formatSubagentDispatch(dispatch), expected);
  }
});
