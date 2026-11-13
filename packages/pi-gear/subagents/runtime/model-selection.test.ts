import assert from "node:assert/strict";
import test from "node:test";
import { formatModelSelection } from "./model-selection.ts";

const cases = [
  { modelSelection: undefined, expected: undefined },
  { modelSelection: {}, expected: undefined },
  { modelSelection: { model: "model" }, expected: "model" },
  { modelSelection: { model: "provider/model", thinkingLevel: "low" as const }, expected: "(provider) model • low" },
  { modelSelection: { model: "provider/org/model", thinkingLevel: "high" as const }, expected: "(provider) org/model • high" },
];

test("formats subagent model selection metadata", () => {
  for (const { modelSelection, expected } of cases) {
    assert.equal(formatModelSelection(modelSelection), expected);
  }
});
