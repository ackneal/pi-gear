import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle, TUI } from "@earendil-works/pi-tui";
import type { ResolvedAgentDefinition, Runtime } from "pi-rostrix";
import type { SubagentServices } from "../../subagents/index.ts";
import { createMonitorFooterComponent } from "./footer.ts";
import { readWorkspaceGitSnapshot } from "./git-status.ts";
import { createSidebarComponent, sidebarOverlayOptions } from "./sidebar.ts";
import {
  buildAgentConfigSummaries,
  createMonitorState,
  extractMainAgentResources,
  resolveSidebarExpanded,
  summarizeSessionUsage,
  type MonitorSnapshot,
  type SessionEntryLike,
} from "./state.ts";

export interface WorkspaceMonitorServices {
  readonly runtime: Runtime;
  readonly subagents: SubagentServices;
}

const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

function resolveAgentSummaries(
  runtime: Runtime,
  subagents: SubagentServices,
  ctx: ExtensionContext,
) {
  const activeAgent = runtime.getActiveAgent();
  const resolved: ResolvedAgentDefinition[] = [];
  for (const agent of runtime.getAllAgents()) {
    try {
      resolved.push(runtime.resolveAgent(agent.id));
    } catch {
      // Skip invalid or partially resolved agent definitions in monitor summary.
    }
  }
  return {
    activeAgentId: activeAgent?.id ?? "default",
    agents: buildAgentConfigSummaries(resolved, subagents.settings, ctx),
  };
}

export function setupWorkspaceMonitor(
  pi: ExtensionAPI,
  services: WorkspaceMonitorServices,
): void {
  const state = createMonitorState();
  let currentCtx: ExtensionContext | undefined;
  let currentTui: TUI | undefined;
  let branchUnsubscribe: (() => void) | undefined;
  let tasksUnsubscribe: (() => void) | undefined;
  let sidebarHandle: OverlayHandle | undefined;
  let mountGeneration = 0;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let gitRefreshSeq = 0;

  const requestRender = () => {
    currentTui?.requestRender();
  };

  const refreshGit = async () => {
    const cwd = currentCtx?.cwd;
    if (!cwd) return;
    const seq = ++gitRefreshSeq;
    const snapshot = await readWorkspaceGitSnapshot(cwd);
    if (seq !== gitRefreshSeq) return;
    state.git = snapshot;
    requestRender();
  };

  const buildSnapshot = (): MonitorSnapshot => {
    const ctx = currentCtx;
    const entries = (ctx?.sessionManager.getEntries() ?? []) as readonly SessionEntryLike[];
    const contextUsage = ctx?.getContextUsage();
    const model = ctx?.model;
    const activeAgent = services.runtime.getActiveAgent();
    const { activeAgentId, agents } = ctx
      ? resolveAgentSummaries(services.runtime, services.subagents, ctx)
      : { activeAgentId: "default", agents: [] };

    return {
      cwd: ctx?.cwd ?? process.cwd(),
      home: process.env.HOME || process.env.USERPROFILE,
      sessionName: pi.getSessionName(),
      git: state.git,
      activeAgent: activeAgentId,
      mainResources: extractMainAgentResources(
        pi.getActiveTools(),
        pi.getCommands(),
        Object.keys(activeAgent?.mcpServers ?? {}),
      ),
      agents,
      tasks: services.runtime.tasks.listTasks(),
      tools: state.toolTracker.snapshot(),
      sessionUsage: summarizeSessionUsage(entries, contextUsage, model?.contextWindow ?? 0),
      ...(model
        ? {
            model: {
              id: model.id,
              provider: model.provider,
              reasoning: model.reasoning,
              thinkingLevel: pi.getThinkingLevel(),
              usingSubscription: ctx?.modelRegistry.isUsingOAuth(model) ?? false,
            },
          }
        : {}),
      availableProviderCount: state.footerData?.getAvailableProviderCount() ?? 1,
      extensionStatuses: state.footerData?.getExtensionStatuses() ?? new Map(),
    };
  };

  const syncTicker = () => {
    const hasRunning = services.runtime.tasks
      .listTasks()
      .some((task) => task.status === "running" || task.status === "pending");
    if (hasRunning && !tickTimer) {
      tickTimer = setInterval(() => {
        const stillRunning = services.runtime.tasks
          .listTasks()
          .some((task) => task.status === "running" || task.status === "pending");
        if (!stillRunning && tickTimer) {
          clearInterval(tickTimer);
          tickTimer = undefined;
        }
        requestRender();
      }, 1000);
      tickTimer.unref?.();
    } else if (!hasRunning && tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
  };

  const disposeUi = (restoreFooter = false) => {
    mountGeneration += 1;
    gitRefreshSeq += 1;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
    branchUnsubscribe?.();
    branchUnsubscribe = undefined;
    tasksUnsubscribe?.();
    tasksUnsubscribe = undefined;
    sidebarHandle?.hide();
    sidebarHandle = undefined;
    if (restoreFooter) {
      currentCtx?.ui.setFooter(undefined);
    }
    state.footerData = undefined;
    currentTui = undefined;
  };

  const mountUi = (ctx: ExtensionContext) => {
    currentCtx = ctx;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    disposeUi(false);
    const generation = mountGeneration;

    ctx.ui.setFooter((tui, theme, footerData) => {
      currentTui = tui;
      state.footerData = footerData;
      branchUnsubscribe = footerData.onBranchChange(() => {
        void refreshGit();
      });

      const component = createMonitorFooterComponent(
        buildSnapshot,
        () => state.manualExpanded,
        theme,
      );
      return {
        ...component,
        dispose() {
          branchUnsubscribe?.();
          branchUnsubscribe = undefined;
          component.dispose?.();
        },
      };
    });

    void ctx.ui.custom<void>(
      (_tui, theme) => createSidebarComponent(buildSnapshot, theme),
      {
        overlay: true,
        overlayOptions: sidebarOverlayOptions(() => state.manualExpanded),
        onHandle: (handle) => {
          if (generation !== mountGeneration) {
            handle.hide();
            return;
          }
          sidebarHandle = handle;
        },
      },
    );

    state.toolTracker.resetFromEntries(
      ctx.sessionManager.getEntries() as readonly SessionEntryLike[],
    );
    tasksUnsubscribe = services.runtime.tasks.subscribe("*", () => {
      syncTicker();
      requestRender();
    });
    syncTicker();
    void refreshGit();
  };

  pi.registerCommand("gear:panel", {
    description: "Toggle workspace monitor sidebar",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const normalized = args.trim().toLowerCase();
      const termWidth = currentTui?.terminal.columns ?? 120;
      if (normalized === "on" || normalized === "open" || normalized === "expand") {
        state.manualExpanded = true;
      } else if (normalized === "off" || normalized === "close" || normalized === "collapse") {
        state.manualExpanded = false;
      } else {
        state.manualExpanded = !resolveSidebarExpanded(state.manualExpanded, termWidth);
      }
      void refreshGit();
      requestRender();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    mountUi(ctx);
  });

  pi.on("session_tree", (_event, ctx) => {
    currentCtx = ctx;
    state.toolTracker.resetFromEntries(
      ctx.sessionManager.getEntries() as readonly SessionEntryLike[],
    );
    void refreshGit();
    requestRender();
  });

  pi.on("session_compact", (_event, ctx) => {
    currentCtx = ctx;
    requestRender();
  });

  pi.on("tool_execution_start", (event, ctx) => {
    currentCtx = ctx;
    state.toolTracker.recordStart(event.toolCallId, event.toolName);
    syncTicker();
    requestRender();
  });

  pi.on("tool_execution_end", (event, ctx) => {
    currentCtx = ctx;
    state.toolTracker.recordEnd(event.toolCallId, event.toolName, event.isError);
    syncTicker();
    if (MUTATING_TOOLS.has(event.toolName)) {
      void refreshGit();
    } else {
      requestRender();
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    currentCtx = ctx;
    syncTicker();
    void refreshGit();
  });

  pi.on("session_shutdown", () => {
    disposeUi(true);
    currentCtx = undefined;
  });
}
