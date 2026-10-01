import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupCommands } from "./commands/index.ts";
import { loadExtensionConfig } from "./config/index.ts";
import { setupPromptComposer } from "./context/prompt/index.ts";
import { setupTaskState } from "./context/state/index.ts";
import { setupExecution } from "./execution/index.ts";
import { setupLifecycle } from "./lifecycle/index.ts";
import { setupLsp } from "./lsp/index.ts";
import { setupSubagents } from "./subagents/index.ts";
import { setupThinkingDisplay } from "./ui/thinking/index.ts";
import { setupWorkspace } from "./workspace/setup.ts";

export default async function gear(pi: ExtensionAPI): Promise<void> {
  const config = await loadExtensionConfig();
  const execution = setupExecution(pi, config);
  const lifecycle = setupLifecycle(pi);
  const workspace = setupWorkspace(pi, execution.filesystem, lifecycle.fff);

  setupTaskState(pi);
  setupPromptComposer(pi);

  setupThinkingDisplay(pi);
  const lsp = setupLsp(pi, { workspace, filesystem: execution.filesystem });

  // Children inherit extension discovery, so pi-gear loads inside every subagent too;
  // the marker set by spawnPiChild keeps subagents from spawning subagents.
  if (process.env.PI_GEAR_CHILD === "1") return;

  const subagents = setupSubagents(pi, workspace);
  setupCommands(pi, { execution, subagents, lsp, workspace });
}
