import test from "node:test";
import assert from "node:assert/strict";
import type { TUI } from "@earendil-works/pi-tui";
import {
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

test("installRightSidebarPatch returns undefined on non-viewport TUI without patching tui.render", () => {
  const originalRender = (width: number) => [`width-${width}`];
  const fakeTui = {
    terminal: { rows: 10, columns: 120 },
    render: originalRender,
  } as unknown as TUI;

  const handle = installRightSidebarPatch(
    fakeTui,
    () => true,
    (sidebarWidth) => [`sidebar-${sidebarWidth}`],
    (text) => text,
  );

  assert.equal(handle, undefined);
  assert.equal(fakeTui.render, originalRender);
});
