import { ScrollView, type Component } from "@earendil-works/pi-tui";
import { renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import {
  BOTTOM_SECTION_HEIGHT,
  frameDetailBox,
  type Theme,
} from "./format.ts";
import type { SubagentViewEntry } from "./registry.ts";

export interface DetailFrameState {
  entry: SubagentViewEntry;
  theme: Theme;
  now: number;
  prevLabel: string;
  nextLabel: string;
}

export class DetailFrameComponent implements Component {
  readonly scrollView: ScrollView;
  private readonly getState: () => DetailFrameState;
  private readonly requestRedraw: () => void;

  constructor(
    content: Component,
    getState: () => DetailFrameState,
    requestRedraw: () => void,
  ) {
    this.getState = getState;
    this.requestRedraw = requestRedraw;
    this.scrollView = new ScrollView(content, {
      follow: "end",
      overscroll: "contain",
    });
  }

  render(width: number): string[] {
    const height = Math.max(10, process.stdout?.rows || 24);
    const viewportHeight = Math.max(1, height - BOTTOM_SECTION_HEIGHT);
    const layout = renderLayoutFrame(
      this.scrollView,
      Math.max(10, width),
      viewportHeight,
      this.requestRedraw,
    );
    const total = layout.root.scrollContentLines?.length ?? 0;
    const start = total === 0 ? 0 : this.scrollView.scrollTop + 1;
    const end = Math.min(total, this.scrollView.scrollTop + viewportHeight);
    const state = this.getState();

    return frameDetailBox(
      layout.lines,
      state.entry,
      width,
      state.theme,
      state.now,
      state.prevLabel,
      state.nextLabel,
      { start, end, total },
    );
  }

  scrollBy(lines: number): void {
    this.scrollView.scrollBy(lines);
  }

  scrollHalfPage(direction: -1 | 1): void {
    const page = Math.max(1, Math.floor(this.scrollView.viewportHeight / 2));
    this.scrollView.scrollBy(direction * page);
  }

  scrollToStart(): void {
    this.scrollView.scrollToStart();
  }

  scrollToEnd(): void {
    this.scrollView.scrollToEnd();
  }

  invalidate(): void {}
}
