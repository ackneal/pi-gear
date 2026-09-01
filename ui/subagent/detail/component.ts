import { Key, matchesKey, type Component, type KeyId } from "@earendil-works/pi-tui";
import type { SubagentRun } from "../../../subagents/runtime/types.ts";
import { DetailContentComponent } from "./content.ts";
import { DetailFrameComponent } from "./frame.ts";
import { titleCase, type Theme } from "./format.ts";
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
  private readonly detailContent: DetailContentComponent;
  private readonly frame: DetailFrameComponent;

  public toolsExpanded: boolean = false;
  public thinkingExpanded: boolean = false;
  public statusText: string = "";

  constructor(options: SubagentDetailComponentOptions) {
    this.theme = options.theme;
    this.onClose = options.onClose;
    this.requestRedraw = options.invalidate;
    this.now = options.now ?? Date.now;
    this.subscribeFn = options.subscribe;
    this.entries = options.entries?.length ? options.entries : [options.entry];
    this.index = Math.min(
      Math.max(0, options.index ?? 0),
      Math.max(0, this.entries.length - 1),
    );
    this.entry = this.entries[this.index] ?? options.entry;

    this.detailContent = new DetailContentComponent(() => ({
      entry: this.entry,
      theme: this.theme,
      now: this.now(),
      toolsExpanded: this.toolsExpanded,
      thinkingExpanded: this.thinkingExpanded,
      statusText: this.statusText,
    }));
    this.frame = new DetailFrameComponent(
      this.detailContent,
      () => ({
        entry: this.entry,
        theme: this.theme,
        now: this.now(),
        prevLabel: this.prevLabel(),
        nextLabel: this.nextLabel(),
      }),
      this.requestRedraw,
    );

    this.subscribeToEntry();
  }

  private subscribeToEntry(): void {
    if (!this.subscribeFn) return;

    this.unsubscribe = this.subscribeFn(this.entry.toolCallId, (run) =>
      this.update(run),
    );
  }

  private select(delta: number): void {
    const nextIndex = this.index + delta;
    if (nextIndex < 0 || nextIndex >= this.entries.length) return;

    this.unsubscribe?.();
    this.index = nextIndex;
    this.entry = this.entries[nextIndex]!;
    this.frame.scrollToEnd();
    this.subscribeToEntry();
    this.requestRedraw();
  }

  render(width: number): string[] {
    return this.frame.render(width);
  }

  private prevLabel(): string {
    const profile = this.entries[this.index - 1]?.profile;
    return profile?.label || profile?.id || "";
  }

  private nextLabel(): string {
    const profile = this.entries[this.index + 1]?.profile;
    return profile?.label || profile?.id || "";
  }

  handleInput(data: string): void {
    const wheel = wheelDirection(data);
    if (wheel !== undefined) {
      this.frame.scrollBy(wheel * 3);
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
    if (keyHit(data, "up", "k", Key.up)) {
      this.frame.scrollBy(-1);
      return;
    }
    if (keyHit(data, "down", "j", Key.down)) {
      this.frame.scrollBy(1);
      return;
    }
    if (keyHit(data, "\x15", "ctrl+u")) {
      this.frame.scrollHalfPage(-1);
      return;
    }
    if (keyHit(data, "\x04", "ctrl+d")) {
      this.frame.scrollHalfPage(1);
      return;
    }
    if (data === "g") {
      this.frame.scrollToStart();
      return;
    }
    if (data === "G") {
      this.frame.scrollToEnd();
    }
  }

  public scrollByLines(lines: number): void {
    this.frame.scrollBy(lines);
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
