import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RostrixRuntime } from "../index.ts";

export interface SetupInteractiveOptions {
  readonly pi: ExtensionAPI;
  readonly runtime: RostrixRuntime;
}

export function setupInteractiveProfiles(options: SetupInteractiveOptions): void {
  const { pi, runtime } = options;

  async function cycleProfile(ctx: any): Promise<void> {
    const available = runtime.discoveredProfiles;
    if (available.length === 0) {
      if (ctx?.ui?.notify) {
        ctx.ui.notify("No profiles found in ~/.pi/agent/profiles or .pi/profiles", "warning");
      }
      return;
    }

    const cycleList: (string | undefined)[] = [undefined, ...available.map((p) => p.profile.id)];
    const currentId = runtime.getActiveProfile()?.id;
    const currentIndex = currentId ? cycleList.indexOf(currentId) : 0;
    const nextIndex = (currentIndex + 1) % cycleList.length;
    const nextId = cycleList[nextIndex];

    if (nextId === undefined) {
      runtime.deactivateProfile();
      if (ctx?.ui?.setStatus) {
        ctx.ui.setStatus("rostrix:profile", "");
      }
      if (ctx?.ui?.notify) {
        ctx.ui.notify("Profile: default (unrestricted)");
      }
      return;
    }

    const found = available.find((p) => p.profile.id === nextId);
    if (!found) return;

    try {
      await runtime.activateProfile(nextId);
      const label = found.profile.label || found.profile.id;
      if (ctx?.ui?.setStatus) {
        ctx.ui.setStatus("rostrix:profile", `👤 ${label}`);
      }
      if (ctx?.ui?.notify) {
        ctx.ui.notify(`Profile: ${label}`);
      }
    } catch (err) {
      if (ctx?.ui?.notify) {
        ctx.ui.notify(`Failed to switch profile: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    }
  }

  // 1. Shortcut: ctrl+r for one-click direct cycling
  if (typeof (pi as any).registerShortcut === "function") {
    (pi as any).registerShortcut("ctrl+r", {
      description: "Cycle agent profile (default -> custom profiles)",
      handler: async (ctx: any) => {
        await cycleProfile(ctx);
      },
    });
  }

  // 2. Command: /profile for manual switching or viewing
  if (typeof (pi as any).registerCommand === "function") {
    (pi as any).registerCommand("profile", {
      description: "Switch or view agent profiles",
      handler: async (args: string, ctx: any) => {
        const trimmed = (args || "").trim();
        const available = runtime.discoveredProfiles;

        if (trimmed === "default" || trimmed === "off") {
          runtime.deactivateProfile();
          if (ctx?.ui?.setStatus) {
            ctx.ui.setStatus("rostrix:profile", "");
          }
          if (ctx?.ui?.notify) {
            ctx.ui.notify("Profile: default (unrestricted)");
          }
          return;
        }

        if (trimmed.length > 0) {
          const target = available.find((p) => p.profile.id === trimmed);
          if (!target) {
            const errorMsg = `Profile '${trimmed}' not found in scanned directories.`;
            if (ctx?.ui?.notify) {
              ctx.ui.notify(errorMsg, "error");
            } else if (typeof (pi as any).sendMessage === "function") {
              (pi as any).sendMessage({ customType: "rostrix:error", content: errorMsg, display: true });
            }
            return;
          }

          try {
            await runtime.activateProfile(target.profile.id);
            const label = target.profile.label || target.profile.id;
            if (ctx?.ui?.setStatus) {
              ctx.ui.setStatus("rostrix:profile", `👤 ${label}`);
            }
            if (ctx?.ui?.notify) {
              ctx.ui.notify(`Profile: ${label}`);
            }
          } catch (err) {
            if (ctx?.ui?.notify) {
              ctx.ui.notify(`Failed to switch profile: ${err instanceof Error ? err.message : String(err)}`, "error");
            }
          }
          return;
        }

        if (available.length === 0) {
          if (ctx?.ui?.notify) {
            ctx.ui.notify("No profiles found in ~/.pi/agent/profiles or .pi/profiles", "warning");
          }
          return;
        }

        if (ctx?.hasUI && ctx?.ui?.select) {
          const activeId = runtime.getActiveProfile()?.id;
          const options = [
            `default ${!activeId ? "(active)" : ""}`.trim(),
            ...available.map((p) =>
              `${p.profile.id} - ${p.profile.label || p.profile.id} ${p.profile.id === activeId ? "(active)" : ""}`.trim(),
            ),
          ];

          const selected = await ctx.ui.select("Select Active Profile", options);
          if (!selected) return;

          if (selected.startsWith("default")) {
            runtime.deactivateProfile();
            if (ctx?.ui?.setStatus) {
              ctx.ui.setStatus("rostrix:profile", "");
            }
            if (ctx?.ui?.notify) {
              ctx.ui.notify("Profile: default (unrestricted)");
            }
          } else {
            const selectedId = selected.split(" - ")[0].replace(" (active)", "").trim();
            const target = available.find((p) => p.profile.id === selectedId);
            if (target) {
              await runtime.activateProfile(target.profile.id);
              const label = target.profile.label || target.profile.id;
              if (ctx?.ui?.setStatus) {
                ctx.ui.setStatus("rostrix:profile", `👤 ${label}`);
              }
              if (ctx?.ui?.notify) {
                ctx.ui.notify(`Profile: ${label}`);
              }
            }
          }
        }
      },
    });
  }
}
