import assert from "node:assert/strict";
import test from "node:test";
import { formatResearcherInput, type ResearcherSubagentInput } from "./index.ts";
import { RESEARCHER_SYSTEM_PROMPT } from "./prompt.ts";

test("researcher prompt requires bounded, evidence-backed conclusions", () => {
  assert.match(RESEARCHER_SYSTEM_PROMPT, /only the delegated question/);
  assert.match(RESEARCHER_SYSTEM_PROMPT, /authoritative sources/);
  assert.match(RESEARCHER_SYSTEM_PROMPT, /distinguish evidence from inference/);
  assert.match(RESEARCHER_SYSTEM_PROMPT, /remaining uncertainty/);
});

test("formatResearcherInput serializes structured research input, omitting absent optional sections", () => {
  const cases: { input: ResearcherSubagentInput; expected: string }[] = [
    { input: { question: "Are dense Qwen models 27B?", scope: undefined }, expected: "Question: Are dense Qwen models 27B?" },
    { input: { question: "x", scope: "official blog posts" }, expected: "Question: x\nScope: official blog posts" },
  ];
  for (const { input, expected } of cases) {
    assert.equal(formatResearcherInput(input), expected);
  }
});
