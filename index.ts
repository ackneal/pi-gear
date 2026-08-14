import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupPromptComposer } from "./context/prompt/index.ts";
import { setupTaskState } from "./context/state/index.ts";
import { setupExecution } from "./execution/index.ts";
import { setupLifecycle } from "./lifecycle/index.ts";
import { setupSubagents } from "./subagents/index.ts";
import { setupThinkingDisplay } from "./ui/thinking/index.ts";

export default function gear(pi: ExtensionAPI): void {
  setupExecution(pi);
  setupLifecycle(pi);

  const state = setupTaskState(pi);
  setupPromptComposer(pi, state);

  setupThinkingDisplay(pi);
  setupSubagents(pi);
}
