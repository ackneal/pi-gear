import assert from "node:assert/strict";
import test from "node:test";
import { ScrollView, type Component } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "./pi-tui-layout.ts";

test("pi-tui compatibility layer renders a constrained ScrollView", () => {
  const content: Component = {
    render: () => Array.from({ length: 8 }, (_, index) => `line ${index + 1}`),
    invalidate: () => {},
  };
  const scrollView = new ScrollView(content, { follow: "end" });

  const frame = renderLayoutFrame(scrollView, 20, 3, () => {});

  assert.equal(scrollView.viewportHeight, 3);
  assert.equal(frame.lines.length, 3);
  assert.deepEqual(frame.lines.map((line) => line.trimEnd()), [
    "line 6",
    "line 7",
    "line 8",
  ]);
});
