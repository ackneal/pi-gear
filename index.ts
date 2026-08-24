import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupCommands } from "./commands/index.ts";
import { setupPromptComposer } from "./context/prompt/index.ts";
import { setupTaskState } from "./context/state/index.ts";
import { setupExecution } from "./execution/index.ts";
import { setupLifecycle } from "./lifecycle/index.ts";
import { setupLsp } from "./lsp/index.ts";
import { setupSubagents } from "./subagents/index.ts";
import { setupThinkingDisplay } from "./ui/thinking/index.ts";

export default function gear(pi: ExtensionAPI): void {
  const execution = setupExecution(pi);
  setupLifecycle(pi);

  setupTaskState(pi);
  setupPromptComposer(pi);

  setupThinkingDisplay(pi);
  const subagents = setupSubagents(pi);
  const lsp = setupLsp(pi);

  setupCommands(pi, { execution, subagents, lsp });
}
