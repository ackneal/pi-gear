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

  constructor(redraw: () => void, format: (run: SubagentRun | undefined, options: ToolRenderResultOptions, icon?: string) => string) {
    super("");
    this.redraw = redraw;
    this.format = format;
  }

  update(run: SubagentRun | undefined, options: ToolRenderResultOptions, format: (run: SubagentRun | undefined, options: ToolRenderResultOptions, icon?: string) => string): void {
    this.run = run;
    this.options = options;
    this.format = format;
    if (run?.status === "running" && options.isPartial) this.start(); else this.stop();
    this.updateText();
  }

  dispose(): void { this.spinner.dispose(); }

  private start(): void {
    this.spinner.start();
  }

  private stop(): void {
    this.spinner.stop();
  }

  private updateText(): void {
    if (!this.options) return;
    const icon = this.run?.status === "running" && this.options.isPartial ? this.spinner.frame : undefined;
    this.setText(this.format(this.run, this.options, icon));
  }
}
