import assert from "node:assert/strict";
import test from "node:test";
import { Container, Text, visibleWidth } from "@earendil-works/pi-tui";
import { configureOutputPadding, padOutput } from "./padding.ts";
import { SubagentResultComponent } from "../subagent/component.ts";

test("shared output padding preserves rows, identity, alignment and bounded width", () => {
  for (const outputPad of [undefined, 0, 1] as const) {
    configureOutputPadding({ getSettings: () => (outputPad === undefined ? {} : { outputPad }) });
    const subagent = new SubagentResultComponent(() => {}, () => "title\nsummary\ndetail");
    subagent.update(undefined, { expanded: true, isPartial: false }, () => "title\nsummary\ndetail");
    const container = new Container();
    container.addChild(new Text("title\n  └ summary\ndetail", 0, 0));
    for (const component of [new Text("title\n  └ summary\ndetail", 0, 0), container, subagent]) {
      assert.equal(padOutput(component), component);
      assert.equal(padOutput(component), component);
      const lines = component.render(40);
      const prefix = outputPad === 0 ? "" : " ";
      assert.equal(lines[0]?.trimEnd(), `${prefix}title`);
      assert.equal(lines[1]?.trimEnd(), component === subagent ? `${prefix}  summary` : `${prefix}  └ summary`);
      assert.equal(lines[2]?.trimEnd(), component === subagent ? `${prefix}  detail` : `${prefix}detail`);
      for (const width of [0, 1, 2, 3, 8, 40]) {
        assert.ok(component.render(width).every((line) => visibleWidth(line) <= width));
      }
    }
    subagent.dispose();
  }
});
