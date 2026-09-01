import type { Component } from "@earendil-works/pi-tui";
import { formatDetailContent, type Theme } from "./format.ts";
import type { SubagentViewEntry } from "./registry.ts";

export interface DetailContentState {
  entry: SubagentViewEntry;
  theme: Theme;
  now: number;
  toolsExpanded: boolean;
  thinkingExpanded: boolean;
  statusText: string;
}

export class DetailContentComponent implements Component {
  private readonly getState: () => DetailContentState;

  constructor(getState: () => DetailContentState) {
    this.getState = getState;
  }

  render(width: number): string[] {
    const state = this.getState();

    return formatDetailContent(
      state.entry,
      state.theme,
      width,
      state.now,
      state.toolsExpanded,
      state.thinkingExpanded,
      state.statusText,
    );
  }

  invalidate(): void {}
}
