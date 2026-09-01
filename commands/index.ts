import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExecutionServices } from "../execution/index.ts";
import type { LspServices } from "../lsp/index.ts";
import type { SubagentServices } from "../subagents/index.ts";
import { formatDoctor } from "./doctor.ts";
import type { WorkspaceServices } from "../workspace/setup.ts";

export const GEAR_COMMANDS = {
  doctor: "gear:doctor",
  subagentInspect: "gear:subagent-inspect",
  subagentModel: "gear:subagent-model",
} as const;

export interface GearCommandServices {
  execution: ExecutionServices;
  subagents: SubagentServices;
  lsp: LspServices;
  workspace?: WorkspaceServices;
}

export function setupCommands(pi: ExtensionAPI, services: GearCommandServices): void {
  pi.registerCommand(GEAR_COMMANDS.subagentInspect, {
    description: "Inspect subagent detail panels",
    handler: async (args, ctx) => {
      await services.subagents.inspect(ctx, args.trim() || undefined);
    },
  });

  pi.registerCommand(GEAR_COMMANDS.subagentModel, {
    description: "Set the persistent model and thinking default for a subagent",
    handler: (args, ctx) => services.subagents.settings.configure(args, ctx),
  });

  pi.registerCommand(GEAR_COMMANDS.doctor, {
    description: "Show pi-gear runtime diagnostics",
    handler: async (_args, ctx) => {
      const lspServers = await services.lsp.statuses(ctx.cwd);
      const output = formatDoctor(
        services.execution.sandbox.status(),
        services.subagents.settings.summaries(ctx),
        pi.getActiveTools(),
        process.platform,
        services.subagents.settings.runtimeError(),
        lspServers,
        await services.workspace?.status(ctx.cwd),
      );
      ctx.ui.notify(output, "info");
    },
  });
}
