import { Key, matchesKey, type Component } from "@earendil-works/pi-tui";
import type { SubagentRun } from "../../../subagents/runtime/types.ts";
import {
  formatDetailContent,
  frameDetailBox,
  titleCase,
  type Theme,
} from "./format.ts";
import type { SubagentViewEntry } from "./registry.ts";

export interface SubagentDetailComponentOptions {
  entry: SubagentViewEntry;
  theme: Theme;
  onClose: () => void;
  invalidate: () => void;
  now?: () => number;
}

export class SubagentDetailComponent implements Component {
  public entry: SubagentViewEntry;
  public theme: Theme;
  public onClose: () => void;
  private readonly requestRedraw: () => void;
  private readonly now: () => number;

  public scrollTop: number = 0;
  public autoScroll: boolean = true;
  public toolsExpanded: boolean = false;
  private lastContentLinesCount: number = 0;
  private lastInnerHeight: number = 10;

  constructor(options: SubagentDetailComponentOptions) {
    this.entry = options.entry;
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.requestRedraw = options.invalidate;
    this.now = options.now ?? Date.now;

    if (process.stdout?.isTTY) {
      process.stdout.write("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
    }
  }

  render(width: number): string[] {
    const termRows = process.stdout?.rows || 24;
    const innerWidth = Math.max(10, width);
    const contentLines = formatDetailContent(
      this.entry,
      this.theme,
      innerWidth,
      this.now(),
      this.toolsExpanded,
    );

    const targetHeight = Math.max(10, termRows);
    const innerHeight = Math.max(1, targetHeight - 3);
    this.lastContentLinesCount = contentLines.length;
    this.lastInnerHeight = innerHeight;

    const maxScroll = Math.max(0, contentLines.length - innerHeight);
    if (this.autoScroll) {
      this.scrollTop = maxScroll;
    } else {
      this.scrollTop = Math.max(0, Math.min(this.scrollTop, maxScroll));
    }

    const title = titleCase(
      this.entry.profile.label || this.entry.profile.id || "Subagent",
    );
    return frameDetailBox(
      contentLines,
      title,
      width,
      targetHeight,
      this.scrollTop,
      this.theme,
      this.toolsExpanded,
    );
  }

  handleInput(data: string): void {
    if (data === "\x1b" || data === "escape" || matchesKey(data, Key.escape) || data === "q") {
      this.onClose();
      return;
    }

    // Toggle tool output expansion with Ctrl+O or 'o'
    if (
      data === "\x0f" ||
      data === "ctrl+o" ||
      data === "o" ||
      data === "O" ||
      matchesKey(data, Key.ctrl("o")) ||
      matchesKey(data, "ctrl+o")
    ) {
      this.toolsExpanded = !this.toolsExpanded;
      this.requestRedraw();
      return;
    }

    const maxScroll = Math.max(
      0,
      this.lastContentLinesCount - this.lastInnerHeight,
    );
    const pageSize = Math.max(1, this.lastInnerHeight - 2);

    // 1. Mouse wheel handling (SGR & X10 tracking)
    const wheelUpMatches = data.match(/\x1b\[<(?:64|68|72|80);\d+;\d+[Mm]|\x1b\[M[`@]/g);
    if (wheelUpMatches) {
      this.autoScroll = false;
      this.scrollTop = Math.max(0, this.scrollTop - wheelUpMatches.length * 2);
      this.requestRedraw();
      return;
    }

    const wheelDownMatches = data.match(/\x1b\[<(?:65|69|73|81);\d+;\d+[Mm]|\x1b\[M[aA]/g);
    if (wheelDownMatches) {
      this.scrollTop = Math.min(maxScroll, this.scrollTop + wheelDownMatches.length * 2);
      if (this.scrollTop >= maxScroll) {
        this.autoScroll = true;
      }
      this.requestRedraw();
      return;
    }

    // Swallow other mouse interactions while overlay is focused to lock focus inside
    if (/^\x1b\[<\d+;\d+;\d+[Mm]|^\x1b\[M.../.test(data)) {
      return;
    }

    // 2. Keyboard scrolling navigation
    if (matchesKey(data, Key.up) || data === "up" || data === "k") {
      this.autoScroll = false;
      this.scrollTop = Math.max(0, this.scrollTop - 1);
      this.requestRedraw();
      return;
    }

    if (matchesKey(data, Key.down) || data === "down" || data === "j") {
      this.scrollTop = Math.min(maxScroll, this.scrollTop + 1);
      if (this.scrollTop >= maxScroll) {
        this.autoScroll = true;
      }
      this.requestRedraw();
      return;
    }

    if (matchesKey(data, Key.pageUp) || data === "pageUp") {
      this.autoScroll = false;
      this.scrollTop = Math.max(0, this.scrollTop - pageSize);
      this.requestRedraw();
      return;
    }

    if (matchesKey(data, Key.pageDown) || data === "pageDown") {
      this.scrollTop = Math.min(maxScroll, this.scrollTop + pageSize);
      if (this.scrollTop >= maxScroll) {
        this.autoScroll = true;
      }
      this.requestRedraw();
      return;
    }

    if (matchesKey(data, Key.home) || data === "home" || data === "g") {
      this.autoScroll = false;
      this.scrollTop = 0;
      this.requestRedraw();
      return;
    }

    if (matchesKey(data, Key.end) || data === "end" || data === "G") {
      this.scrollTop = maxScroll;
      this.autoScroll = true;
      this.requestRedraw();
      return;
    }
  }

  update(run: SubagentRun): void {
    this.entry.run = run;
    this.entry.updatedAt = this.now();
    if (this.autoScroll) {
      const maxScroll = Math.max(
        0,
        this.lastContentLinesCount - this.lastInnerHeight,
      );
      this.scrollTop = maxScroll;
    }
    this.requestRedraw();
  }

  invalidate(): void {}

  dispose(): void {
    if (process.stdout?.isTTY) {
      process.stdout.write("\x1b[?1000l\x1b[?1002l\x1b[?1006l");
    }
  }
}
