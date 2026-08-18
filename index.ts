import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupPromptComposer } from "./context/prompt/index.ts";
import { setupTaskState } from "./context/state/index.ts";
import { setupExecution } from "./execution/index.ts";
import { setupLifecycle } from "./lifecycle/index.ts";
import { setupSubagents } from "./subagents/index.ts";
import { setupThinkingDisplay } from "./ui/thinking/index.ts";

export default function gear(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    if (typeof ctx.ui?.setWidget === "function") {
      ctx.ui.setWidget("__tui_clear_on_shrink", (tui) => {
        if (typeof (tui as unknown as { setClearOnShrink?: (val: boolean) => void }).setClearOnShrink === "function") {
          (tui as unknown as { setClearOnShrink: (val: boolean) => void }).setClearOnShrink(true);
        }
        return { render: () => [], invalidate: () => {} };
      });
    }
  });

  setupExecution(pi);
  setupLifecycle(pi);

  setupTaskState(pi);
  setupPromptComposer(pi);

  setupThinkingDisplay(pi);
  setupSubagents(pi);
}
