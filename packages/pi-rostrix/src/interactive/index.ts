import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../runtime.ts";

export interface AgentControlsOptions {
  readonly pi: ExtensionAPI;
  readonly runtime: Runtime;
  readonly shortcut?: string | undefined;
  readonly commandName?: string | false | undefined;
  readonly statusKey?: string | undefined;
}

export function registerAgentControls(options: AgentControlsOptions): void {
  const { pi, runtime } = options;
  const commandName = options.commandName !== undefined ? options.commandName : "rostrix:agents";
  const statusKey = options.statusKey ?? "rostrix:agent";

  async function cycleAgent(ctx: any): Promise<void> {
    const available = runtime.discoveredAgents;
    if (available.length === 0) {
      if (ctx?.ui?.notify) {
        ctx.ui.notify("No agents found in ~/.pi/agent/rostrix or .pi/rostrix", "warning");
      }
      return;
    }

    const cycleList: (string | undefined)[] = [undefined, ...available.map(({ agent }) => agent.id)];
    const currentId = runtime.getActiveAgent()?.id;
    const currentIndex = currentId ? cycleList.indexOf(currentId) : 0;
    const nextIndex = (currentIndex + 1) % cycleList.length;
    const nextId = cycleList[nextIndex];

    if (nextId === undefined) {
      runtime.deactivateAgent();
      if (ctx?.ui?.setStatus) {
        ctx.ui.setStatus(statusKey, "");
      }
      if (ctx?.ui?.notify) {
        ctx.ui.notify("Agent: default (unrestricted)");
      }
      return;
    }

    const found = available.find(({ agent }) => agent.id === nextId);
    if (!found) return;
    const def = found.agent;

    try {
      await runtime.activateAgent(nextId);
      const label = def?.label || def?.id || nextId;
      if (ctx?.ui?.setStatus) {
        ctx.ui.setStatus(statusKey, `👤 ${label}`);
      }
      if (ctx?.ui?.notify) {
        ctx.ui.notify(`Agent: ${label}`);
      }
    } catch (err) {
      if (ctx?.ui?.notify) {
        ctx.ui.notify(`Failed to switch agent: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
  }

  // 1. Optional Shortcut: registered only if explicitly configured
  if (options.shortcut && typeof (pi as any).registerShortcut === "function") {
    (pi as any).registerShortcut(options.shortcut, {
      description: "Cycle agent (default -> custom agents)",
      handler: async (ctx: any) => {
        await cycleAgent(ctx);
      },
    });
  }

  // Command selection also supports direct switching.
  if (typeof (pi as any).registerCommand === "function") {
    const handleAgentCommand = async (args: string, ctx: any) => {
      const trimmed = (args || "").trim();
      const available = runtime.discoveredAgents;

      if (available.length === 0) {
        if (ctx?.ui?.notify) {
          ctx.ui.notify("No agents found in ~/.pi/agent/rostrix or .pi/rostrix", "warning");
        }
        return;
      }

      if (trimmed === "default" || trimmed === "off") {
        runtime.deactivateAgent();
        if (ctx?.ui?.setStatus) {
          ctx.ui.setStatus(statusKey, "");
        }
        if (ctx?.ui?.notify) {
          ctx.ui.notify("Agent: default (unrestricted)");
        }
        return;
      }

      if (trimmed.length > 0) {
        const target = available.find(({ agent }) => agent.id === trimmed);
        if (!target) {
          const errorMsg = `Agent '${trimmed}' not found in scanned directories.`;
          if (ctx?.ui?.notify) {
            ctx.ui.notify(errorMsg, "error");
          } else if (typeof (pi as any).sendMessage === "function") {
            (pi as any).sendMessage({ customType: "rostrix:error", content: errorMsg, display: true });
          }
          return;
        }

        const def = target.agent;
        try {
          await runtime.activateAgent(def.id);
          const label = def.label || def.id;
          if (ctx?.ui?.setStatus) {
            ctx.ui.setStatus(statusKey, `👤 ${label}`);
          }
          if (ctx?.ui?.notify) {
            ctx.ui.notify(`Agent: ${label}`);
          }
        } catch (err) {
          if (ctx?.ui?.notify) {
            ctx.ui.notify(`Failed to switch agent: ${err instanceof Error ? err.message : String(err)}`, "error");
          }
        }
        return;
      }

      // Default: no arguments -> open interactive selector
      if (ctx?.hasUI && ctx?.ui?.select) {
        const activeId = runtime.getActiveAgent()?.id;
        const optionsList = [
          `default ${!activeId ? "(active)" : ""}`.trim(),
          ...available.map(({ agent: def }) => {
            return `${def.id} - ${def.label || def.id} ${def.id === activeId ? "(active)" : ""}`.trim();
          }),
        ];

        const selected = await ctx.ui.select("Select Active Agent", optionsList);
        if (!selected) return;

        if (selected.startsWith("default")) {
          runtime.deactivateAgent();
          if (ctx?.ui?.setStatus) {
            ctx.ui.setStatus(statusKey, "");
          }
          if (ctx?.ui?.notify) {
            ctx.ui.notify("Agent: default (unrestricted)");
          }
        } else {
          const selectedId = selected.split(" - ")[0].replace(" (active)", "").trim();
          const target = available.find(({ agent }) => agent.id === selectedId);
          if (target) {
            const def = target.agent;
            await runtime.activateAgent(def.id);
            const label = def.label || def.id;
            if (ctx?.ui?.setStatus) {
              ctx.ui.setStatus(statusKey, `👤 ${label}`);
            }
            if (ctx?.ui?.notify) {
              ctx.ui.notify(`Agent: ${label}`);
            }
          }
        }
      }
    };

    if (commandName && typeof (pi as any).registerCommand === "function") {
      (pi as any).registerCommand(commandName, {
        description: "Select or switch active agent",
        handler: handleAgentCommand,
      });
    }
  }
}
