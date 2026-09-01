import type { ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SubagentRun } from "../../subagents/runtime/types.ts";
import { Spinner } from "./spinner.ts";

export class SubagentResultComponent extends Text {
  private readonly spinner = new Spinner(() => {
    this.updateText();
    this.redraw();
  });
  private run: SubagentRun | undefined;
  private options: ToolRenderResultOptions | undefined;
  private readonly redraw: () => void;
  private format: (run: SubagentRun | undefined, options: ToolRenderResultOptions, icon?: string) => string;
  private live = false;
  private liveToolCallId: string | undefined;
  private unsubscribe: (() => void) | undefined;

  constructor(redraw: () => void, format: (run: SubagentRun | undefined, options: ToolRenderResultOptions, icon?: string) => string) {
    super("", 0, 0);
    this.redraw = redraw;
    this.format = format;
  }

  update(run: SubagentRun | undefined, options: ToolRenderResultOptions, format: (run: SubagentRun | undefined, options: ToolRenderResultOptions, icon?: string) => string): void {
    this.run = run;
    this.options = options;
    this.format = format;
    this.syncSpinner();
    this.updateText();
  }

  bindLive(toolCallId: string, subscribe: (listener: (run: SubagentRun) => void) => () => void): void {
    if (this.liveToolCallId === toolCallId) return;
    this.unsubscribe?.();
    this.live = true;
    this.liveToolCallId = toolCallId;
    this.unsubscribe = subscribe((run) => {
      this.run = run;
      this.syncSpinner();
      this.updateText();
      this.redraw();
      if (run.status !== "running") this.releaseLiveSubscription();
    });
    this.syncSpinner();
  }

  dispose(): void {
    this.releaseLiveSubscription();
    this.spinner.dispose();
  }

  private start(): void {
    this.spinner.start();
  }

  private stop(): void {
    this.spinner.stop();
  }

  private syncSpinner(): void {
    if (this.run?.status === "running" && this.options?.isPartial && !this.live) this.start(); else this.stop();
  }

  private releaseLiveSubscription(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.live = false;
    this.liveToolCallId = undefined;
  }

  private updateText(): void {
    if (!this.options) return;
    const icon = this.run?.status === "running" && this.options.isPartial && !this.live ? this.spinner.frame : undefined;
    this.setText(this.format(this.run, this.options, icon));
  }
}
