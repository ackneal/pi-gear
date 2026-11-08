import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initRostrix } from "pi-rostrix";
import { setupCommands } from "./commands/index.ts";
import { loadExtensionConfig } from "./config/index.ts";
import { setupPromptComposer } from "./context/prompt/index.ts";
import { setupTaskState } from "./context/state/index.ts";
import { setupExecution } from "./execution/index.ts";
import { setupLifecycle } from "./lifecycle/index.ts";
import { setupLsp } from "./lsp/index.ts";
import { ALL_GEAR_PROFILES } from "./profiles/gear-profiles.ts";
import { setupSubagents } from "./subagents/index.ts";
import { setupThinkingDisplay } from "./ui/thinking/index.ts";
import { setupWorkspace } from "./workspace/setup.ts";

export default async function gear(pi: ExtensionAPI): Promise<void> {
  const child = process.env.PI_GEAR_CHILD === "1";
  const config = await loadExtensionConfig();
  const execution = setupExecution(pi, config, { child });
  const lifecycle = setupLifecycle(pi, { child });
  const workspace = setupWorkspace(pi, execution.filesystem, lifecycle.fff);

  // Initialize Rostrix runtime and register gear profiles
  const rostrix = initRostrix(pi);
  for (const profile of ALL_GEAR_PROFILES) {
    if (!rostrix.getProfile(profile.id)) {
      rostrix.registerProfile(profile);
    }
  }

  setupTaskState(pi);
  setupPromptComposer(pi);

  setupThinkingDisplay(pi);
  const lsp = setupLsp(pi, { workspace, filesystem: execution.filesystem });

  // Children share runtime services but cannot spawn another layer of subagents.
  if (child) return;

  const subagents = setupSubagents(pi, workspace);
  setupCommands(pi, { execution, subagents, lsp, workspace });
}
