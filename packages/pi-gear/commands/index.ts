import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "pi-rostrix";
import { registerAgentControls } from "pi-rostrix";
import type { ExecutionServices } from "../execution/index.ts";
import type { LspServices } from "../lsp/index.ts";
import type { SubagentServices } from "../subagents/index.ts";
import { formatDoctor } from "./doctor.ts";
import type { WorkspaceServices } from "../workspace/setup.ts";

export const COMMANDS = {
  doctor: "gear:doctor",
  subagentModel: "gear:subagent-model",
  agents: "gear:agents",
} as const;

export interface CommandServices {
  execution: ExecutionServices;
  subagents: SubagentServices;
  lsp: LspServices;
  workspace?: WorkspaceServices;
  runtime?: Runtime;
}

export function setupCommands(pi: ExtensionAPI, services: CommandServices): void {
  pi.registerCommand(COMMANDS.subagentModel, {
    description: "Set the persistent model and thinking default for a subagent",
    handler: (args, ctx) => services.subagents.settings.configure(args, ctx),
  });

  pi.registerCommand(COMMANDS.doctor, {
    description: "Show pi-gear runtime diagnostics",
    handler: async (_args, ctx) => {
      const lspServers = await services.lsp.statuses(ctx.cwd);
      const output = formatDoctor(
        services.execution.sandbox.status(),
        services.subagents.settings.summaries(ctx),
        pi.getActiveTools(),
        process.platform,
        services.subagents.settings.settingsError(),
        lspServers,
        await services.workspace?.status(ctx.cwd),
      );
      pi.sendMessage({ customType: COMMANDS.doctor, content: output, display: true });
    },
  });

  if (services.runtime) {
    registerAgentControls({
      pi,
      runtime: services.runtime,
      commandName: COMMANDS.agents,
    });
  } else {
    pi.registerCommand(COMMANDS.agents, {
      description: "Select or switch active agent",
      handler: async (_args, ctx) => {
        ctx?.ui?.notify?.("Agent runtime is not available", "warning");
      },
    });
  }
}
