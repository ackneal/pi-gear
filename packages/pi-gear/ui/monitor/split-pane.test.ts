import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth, type TUI } from "@earendil-works/pi-tui";
import {
  composeSideBySideLines,
  computeSplitWidths,
  installRightSidebarPatch,
} from "./split-pane.ts";

test("computeSplitWidths activates split only when terminal width >= 110", () => {
  assert.deepEqual(computeSplitWidths(109), {
    splitActive: false,
    mainWidth: 109,
    sidebarWidth: 0,
  });

  const wide = computeSplitWidths(120);
  assert.equal(wide.splitActive, true);
  assert.equal(wide.sidebarWidth, 36);
  assert.equal(wide.mainWidth + 3 + wide.sidebarWidth, 120);
});

test("composeSideBySideLines joins left and right columns, anchors viewport, and preserves image lines", () => {
  const mainLines = [
    "history-1",
    "\x1b_Gi=1;AAAA\x1b\\",
    "editor-line",
    "footer-line",
  ];
  const sidebarLines = ["─ Monitor ──", "Git main", "Agent default"];

  const composed = composeSideBySideLines(mainLines, sidebarLines, 20, 14, 3);

  assert.equal(composed.length, 4);
  assert.equal(composed[1], "\x1b_Gi=1;AAAA\x1b\\");
  assert.ok(composed[0]?.includes(" │ "));
  assert.equal(visibleWidth(composed[0] ?? ""), 37);
  assert.ok(composed[2]?.includes("Git main"));
  assert.ok(composed[3]?.includes("Agent default"));
});

test("installRightSidebarPatch wraps tui.render when enabled and restores original on uninstall", () => {
  const renderWidths: number[] = [];
  let enabled = true;
  const fakeTui = {
    terminal: { rows: 10, columns: 120 },
    render(width: number): string[] {
      renderWidths.push(width);
      return ["main-row-1", "main-row-2"];
    },
  } as unknown as TUI;

  const originalRender = fakeTui.render;
  const handle = installRightSidebarPatch(
    fakeTui,
    () => enabled,
    (sidebarWidth) => [`sidebar-${sidebarWidth}`],
    (text) => text,
  );

  const splitOutput = fakeTui.render(120);
  assert.equal(renderWidths[0], 81);
  assert.ok(splitOutput[0]?.includes("main-row-1") && splitOutput[0]?.includes("sidebar-36"));

  enabled = false;
  const passthroughOutput = fakeTui.render(120);
  assert.equal(renderWidths[1], 120);
  assert.deepEqual(passthroughOutput, ["main-row-1", "main-row-2"]);

  handle.uninstall();
  assert.equal(fakeTui.render, originalRender);
});
