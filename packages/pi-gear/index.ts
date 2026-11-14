import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { init } from "pi-rostrix";
import { setupCommands } from "./commands/index.ts";
import { loadExtensionConfig } from "./config/index.ts";
import { setupPromptComposer } from "./context/prompt/index.ts";
import { setupTaskState } from "./context/state/index.ts";
import { setupExecution } from "./execution/index.ts";
import { setupLifecycle } from "./lifecycle/index.ts";
import { setupLsp } from "./lsp/index.ts";
import { BUILTIN_AGENT_DEFINITIONS } from "./agents/definitions.ts";
import { setupSubagents } from "./subagents/index.ts";
import { setupThinkingDisplay } from "./ui/thinking/index.ts";
import { setupWorkspace } from "./workspace/setup.ts";

export default async function extension(pi: ExtensionAPI): Promise<void> {
  return setupExtension(pi, { child: process.env.PI_GEAR_CHILD === "1" });
}

export async function setupExtension(
  pi: ExtensionAPI,
  options: { child: boolean; fffEndpoint?: ((cwd?: string) => string | undefined) | undefined },
): Promise<void> {
  const { child, fffEndpoint } = options;
  const config = await loadExtensionConfig();
  const execution = setupExecution(pi, config, { child });
  const lifecycle = setupLifecycle(pi, { child });
  const fffSource = fffEndpoint
    ? {
        current: lifecycle.fff.current,
        endpoint: (cwd?: string) => lifecycle.fff.endpoint(cwd) ?? fffEndpoint(cwd),
        failure: lifecycle.fff.failure,
      }
    : lifecycle.fff;
  const workspace = setupWorkspace(pi, execution.filesystem, fffSource);

  const runtime = init(pi, {
    autoRegisterTaskTools: false,
    autoRegisterAgentControls: false,
    autoLoadDefinitions: !child,
    ...(config.subagents?.stallTimeoutSeconds !== undefined
      ? { stallTimeoutMs: config.subagents.stallTimeoutSeconds * 1000 }
      : {}),
  });
  for (const definition of BUILTIN_AGENT_DEFINITIONS) {
    if (!runtime.getAgent(definition.id)) {
      runtime.registerAgent(definition);
    }
  }

  if (!child) setupTaskState(pi);
  setupPromptComposer(pi);

  setupThinkingDisplay(pi);
  const lsp = setupLsp(pi, { workspace, filesystem: execution.filesystem });

  // Children share runtime services but cannot spawn another layer of subagents.
  if (child) return;

  const subagents = setupSubagents(pi, workspace, runtime, config);
  setupCommands(pi, { execution, subagents, lsp, workspace, runtime });
}
