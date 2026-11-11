import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme, type AgentToolResult, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { researcherProfile } from "../../subagents/agents/researcher/index.ts";
import type { SubagentRun } from "../../subagents/runtime/types.ts";
import { SubagentResultComponent } from "./component.ts";
import type { Theme } from "./format.ts";
import { renderSubagentResult } from "./renderer.ts";

initTheme();

const theme: Theme = { fg: (_color, text) => text, bold: (text) => text };

const cases: {
  name: string;
  run: Partial<SubagentRun>;
  expanded: boolean;
  width: number;
  task?: string;
  assertOutput: (text: string, lines: string[]) => void;
}[] = [
  {
    name: "expanded bold and emphasis retain text without markers",
    run: { result: "**Bold answer** and *emphasized answer*" },
    expanded: true,
    width: 100,
    assertOutput: (text) => {
      assert.match(text, /Bold answer and emphasized answer/);
      assert.doesNotMatch(text, /\*/);
    },
  },
  {
    name: "expanded fenced code preserves indentation and identifiers",
    run: { result: "```js\nif (ready) {\n    const run_example = 42;\n}\n```" },
    expanded: true,
    width: 100,
    assertOutput: (text) => {
      assert.match(text, /if \(ready\) \{/);
      assert.match(text, /\n {9}const run_example = 42;/);
    },
  },
  {
    name: "expanded JSON code retains all keys and spacing",
    run: { result: '```json\n{\n    "custom": "value"\n}\n```' },
    expanded: true,
    width: 100,
    assertOutput: (text) => {
      assert.match(text, /\n {9}"custom": "value"/);
    },
  },
  {
    name: "expanded lists retain separate items and render inline markdown",
    run: { result: "- **First item**\n- *Second item*\n\n1. Ordered item\n2. Final item" },
    expanded: true,
    width: 100,
    assertOutput: (text, lines) => {
      for (const item of ["First item", "Second item", "Ordered item", "Final item"]) {
        assert.equal(lines.filter((line) => line.includes(item)).length, 1);
      }
      assert.doesNotMatch(text, /\*/);
      assert.match(text, /1\. Ordered item/);
      assert.match(text, /2\. Final item/);
    },
  },
  {
    name: "expanded markdown wraps at narrow visible width without losing text",
    run: { result: "**窄幅 answer** with enough words to wrap across several lines and retain the ending." },
    expanded: true,
    width: 24,
    assertOutput: (text, lines) => {
      for (const line of lines) assert.ok(visibleWidth(line) <= 24, JSON.stringify(line));
      assert.ok(text.replace(/\s/g, "").includes("窄幅answerwithenoughwordstowrapacrossseverallinesandretaintheending."));
      assert.doesNotMatch(text, /\*\*/);
    },
  },
  {
    name: "collapsed result does not expose the answer",
    run: { result: "**Secret final answer**" },
    expanded: false,
    width: 100,
    assertOutput: (text) => {
      assert.match(text, /Research complete/);
      assert.doesNotMatch(text, /Secret final answer/);
    },
  },
  {
    name: "task and activity remain literal while the answer renders markdown",
    run: {
      result: "**Rendered answer**",
      activities: [{ kind: "tool", name: "read", status: "success", args: { path: "activity **literal**" } }],
    },
    expanded: true,
    width: 100,
    task: "task **literal**",
    assertOutput: (text) => {
      assert.match(text, /task \*\*literal\*\*/);
      assert.match(text, /Execution history/);
      assert.match(text, /activity \*\*literal\*\*/);
      assert.match(text, /Rendered answer/);
      assert.doesNotMatch(text, /\*\*Rendered answer\*\*/);
    },
  },
  {
    name: "expanded error text remains literal",
    run: { status: "error", error: "failure **literal**\nsecond *literal* line" },
    expanded: true,
    width: 100,
    assertOutput: (text) => {
      assert.match(text, /failure \*\*literal\*\*/);
      assert.match(text, /second \*literal\* line/);
    },
  },
];

for (const entry of cases) {
  test(entry.name, () => {
    const run: SubagentRun = { status: "success", startedAt: 0, finishedAt: 1000, activities: [], ...entry.run };
    const result: AgentToolResult<SubagentRun> = { content: [], details: run };
    const options: ToolRenderResultOptions = { expanded: entry.expanded, isPartial: false };
    const component = renderSubagentResult(researcherProfile, result, options, theme, {
      args: { task: entry.task },
      invalidate: () => {},
    });

    try {
      const lines = component.render(entry.width);
      entry.assertOutput(lines.map(stripVTControlCharacters).join("\n"), lines.map(stripVTControlCharacters));
    } finally {
      if (component instanceof SubagentResultComponent) component.dispose();
    }
  });
}
