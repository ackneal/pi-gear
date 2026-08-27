import { Key, matchesKey, ScrollView, type Component, type KeyId } from "@earendil-works/pi-tui";
import type { SubagentRun } from "../../../subagents/runtime/types.ts";
import {
  BOTTOM_SECTION_HEIGHT,
  formatDetailContent,
  frameDetailBox,
  titleCase,
  type Theme,
} from "./format.ts";
import type { SubagentViewEntry } from "./registry.ts";

function keyHit(data: string, ...keys: (KeyId | string)[]): boolean {
  return keys.some((key) => data === key || matchesKey(data, key as KeyId));
}

function wheelDirection(data: string): -1 | 1 | undefined {
  const sgr = /^\x1b\[<(\d+);\d+;\d+[Mm]$/.exec(data);
  const button = sgr
    ? Number.parseInt(sgr[1]!, 10)
    : data.length === 6 && data.startsWith("\x1b[M")
      ? data.charCodeAt(3) - 32
      : undefined;
  if (button === undefined || (button & 64) === 0) return undefined;

  const direction = button & 3;
  if (direction === 0) return -1;
  if (direction === 1) return 1;
  return undefined;
}

export interface SubagentDetailComponentOptions {
  entry: SubagentViewEntry;
  theme: Theme;
  onClose: () => void;
  invalidate: () => void;
  now?: () => number;
  entries?: SubagentViewEntry[];
  index?: number;
  subscribe?: (
    toolCallId: string,
    listener: (run: SubagentRun) => void,
  ) => () => void;
}

export class SubagentDetailComponent implements Component {
  public entry: SubagentViewEntry;
  public theme: Theme;
  public onClose: () => void;
  private readonly requestRedraw: () => void;
  private readonly now: () => number;
  private readonly subscribeFn:
    | ((toolCallId: string, listener: (run: SubagentRun) => void) => () => void)
    | undefined;
  private readonly entries: SubagentViewEntry[];
  private index: number;
  private unsubscribe: (() => void) | undefined;
  private readonly scrollView = new ScrollView(
    { render: () => [], invalidate: () => {} },
    { follow: "end" },
  );

  public get scrollTop(): number { return this.scrollView.scrollTop; }
  public get autoScroll(): boolean { return this.scrollView.isFollowingEnd; }
  public toolsExpanded: boolean = false;
  public thinkingExpanded: boolean = false;
  public statusText: string = "";
  private lastInnerHeight: number = 10;

  constructor(options: SubagentDetailComponentOptions) {
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.requestRedraw = options.invalidate;
    this.now = options.now ?? Date.now;
    this.subscribeFn = options.subscribe;
    this.entries =
      options.entries && options.entries.length > 0
        ? options.entries
        : options.entry
          ? [options.entry]
          : [];
    this.index = Math.min(
      Math.max(0, options.index ?? 0),
      Math.max(0, this.entries.length - 1),
    );
    this.entry = this.entries[this.index] ?? options.entry;
    if (this.subscribeFn) {
      this.unsubscribe = this.subscribeFn(this.entry.toolCallId, (run) =>
        this.update(run),
      );
    }
  }

  private select(delta: number): void {
    const i = this.index + delta;
    if (i < 0 || i >= this.entries.length || !this.entries[i]) return;
    this.unsubscribe?.();
    this.index = i;
    this.entry = this.entries[i]!;
    // Keep toolsExpanded / thinkingExpanded / statusText across windows.
    this.scrollView.scrollToEnd();
    if (this.subscribeFn) {
      this.unsubscribe = this.subscribeFn(this.entry.toolCallId, (run) =>
        this.update(run),
      );
    }
    this.requestRedraw();
  }

  render(width: number): string[] {
    const termRows = process.stdout?.rows || 24;
    const innerWidth = Math.max(10, width);
    const innerHeight = Math.max(
      1,
      Math.max(10, termRows) - BOTTOM_SECTION_HEIGHT,
    );

    const contentLines = formatDetailContent(
      this.entry,
      this.theme,
      innerWidth,
      this.now(),
      this.toolsExpanded,
      this.thinkingExpanded,
      this.statusText,
    );

    this.lastInnerHeight = innerHeight;
    this.scrollView.updateLayout(contentLines.length, innerHeight, this.requestRedraw);

    return frameDetailBox(
      contentLines,
      this.entry,
      width,
      Math.max(10, termRows),
      this.scrollView.scrollTop,
      this.theme,
      this.now(),
      this.prevLabel(),
      this.nextLabel(),
    );
  }

  private prevLabel(): string {
    return this.entries[this.index - 1]?.profile.label || this.entries[this.index - 1]?.profile.id || "";
  }

  private nextLabel(): string {
    return this.entries[this.index + 1]?.profile.label || this.entries[this.index + 1]?.profile.id || "";
  }

  handleInput(data: string): void {
    const wheel = wheelDirection(data);
    if (wheel !== undefined) {
      this.scrollView.scrollBy(wheel * 3);
      return;
    }

    if (keyHit(data, "\x1b[D", "left", "h", Key.left)) {
      this.select(-1);
      return;
    }
    if (keyHit(data, "\x1b[C", "right", "l", Key.right)) {
      this.select(1);
      return;
    }

    if (keyHit(data, "\x1b", "escape", "q", Key.escape)) {
      this.onClose();
      return;
    }

    if (keyHit(data, "\x0f", "ctrl+o")) {
      this.toolsExpanded = !this.toolsExpanded;
      this.statusText = this.toolsExpanded
        ? "Tool output: expanded"
        : "Tool output: collapsed";
      this.requestRedraw();
      return;
    }

    if (keyHit(data, "\x14", "ctrl+t")) {
      this.thinkingExpanded = !this.thinkingExpanded;
      this.statusText = this.thinkingExpanded
        ? "Thinking blocks: visible"
        : "Thinking blocks: hidden";
      this.requestRedraw();
      return;
    }

    const halfPage = Math.max(1, Math.floor(Math.max(1, this.lastInnerHeight - 2) / 2));

    if (keyHit(data, "up", "k", Key.up)) {
      this.scrollByLines(-1);
      return;
    }
    if (keyHit(data, "down", "j", Key.down)) {
      this.scrollByLines(1);
      return;
    }

    if (keyHit(data, "\x15", "ctrl+u")) {
      this.scrollByLines(-halfPage);
      return;
    }
    if (keyHit(data, "\x04", "ctrl+d")) {
      this.scrollByLines(halfPage);
      return;
    }

    // Vim top/bottom (Home/End omitted: macOS has no such keys)
    if (data === "g") {
      this.scrollView.scrollToStart();
      return;
    }
    if (data === "G") {
      this.scrollView.scrollToEnd();
      return;
    }
  }

  public scrollByLines(lines: number): void {
    this.scrollView.scrollBy(lines);
  }

  update(run: SubagentRun): void {
    this.entry.run = run;
    this.entry.updatedAt = this.now();
    this.requestRedraw();
  }

  invalidate(): void {}

  dispose(): void {
    this.unsubscribe?.();
  }
}
