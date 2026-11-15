import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { ResolvedAgentDefinition, Runtime } from "pi-rostrix";
import type { SubagentServices } from "../../subagents/index.ts";
import { createMonitorFooterComponent } from "./footer.ts";
import { readWorkspaceGitSnapshot } from "./git-status.ts";
import { createMonitorPanelComponent, renderMonitorSidebar } from "./panel.ts";
import {
  computeSplitWidths,
  installRightSidebarPatch,
  type SplitPaneHandle,
} from "./split-pane.ts";
import {
  buildAgentConfigSummaries,
  createMonitorState,
  extractMainAgentResources,
  nextPanelMode,
  resolvePanelMode,
  summarizeSessionUsage,
  type AgentConfigSummary,
  type MainAgentResources,
  type MonitorSnapshot,
  type PanelMode,
  type SessionEntryLike,
  type SessionUsageSnapshot,
} from "./state.ts";

export interface WorkspaceMonitorServices {
  readonly runtime: Runtime;
  readonly subagents: SubagentServices;
}

const MONITOR_WIDGET_KEY = "pi-gear.monitor";
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
  let splitPaneHandle: SplitPaneHandle | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let gitRefreshSeq = 0;
  let cachedActiveAgentId = "default";
  let cachedAgents: AgentConfigSummary[] = [];
  let cachedMainResources: MainAgentResources = { toolsCount: 0, tools: [], skills: [], mcpServers: [] };
  let cachedSessionUsage: SessionUsageSnapshot = {
    turns: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: null,
    contextWindow: 0,
    contextPercent: null,
  };

  const requestRender = () => {
    currentTui?.requestRender();
  };

  const refreshSessionCache = (ctx: ExtensionContext | undefined) => {
    const activeAgent = services.runtime.getActiveAgent();
    if (ctx) {
      const summary = resolveAgentSummaries(services.runtime, services.subagents, ctx);
      cachedActiveAgentId = summary.activeAgentId;
      cachedAgents = summary.agents;
      const entries = ctx.sessionManager.getEntries() as readonly SessionEntryLike[];
      cachedSessionUsage = summarizeSessionUsage(
        entries,
        ctx.getContextUsage(),
        ctx.model?.contextWindow ?? 0,
      );
    } else {
      cachedActiveAgentId = activeAgent?.id ?? "default";
      cachedAgents = [];
    }
    cachedMainResources = extractMainAgentResources(
      pi.getActiveTools(),
      pi.getCommands(),
      Object.keys(activeAgent?.mcpServers ?? {}),
    );
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
    const contextUsage = ctx?.getContextUsage();
    const model = ctx?.model;
    const contextWindow = contextUsage?.contextWindow ?? model?.contextWindow ?? cachedSessionUsage.contextWindow;
    const contextTokens = contextUsage ? contextUsage.tokens : cachedSessionUsage.contextTokens;
    const contextPercent = contextUsage ? contextUsage.percent : cachedSessionUsage.contextPercent;

    return {
      cwd: ctx?.cwd ?? process.cwd(),
      home: process.env.HOME || process.env.USERPROFILE,
      sessionName: pi.getSessionName(),
      git: state.git,
      activeAgent: cachedActiveAgentId,
      mainResources: cachedMainResources,
      agents: cachedAgents,
      tasks: services.runtime.tasks.listTasks(),
      tools: state.toolTracker.snapshot(),
      sessionUsage: {
        ...cachedSessionUsage,
        contextTokens,
        contextWindow,
        contextPercent,
      },
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

  const syncWidget = (ctx: ExtensionContext | undefined, splitActiveOverride?: boolean) => {
    if (!ctx?.hasUI || ctx.mode !== "tui") return;
    const expanded = resolvePanelMode(state.panelMode) !== "collapsed";
    const splitActive = splitActiveOverride ?? (
      expanded && currentTui
        ? computeSplitWidths(currentTui.terminal.columns).splitActive && !currentTui.hasOverlay()
        : false
    );
    if (!expanded || splitActive) {
      ctx.ui.setWidget(MONITOR_WIDGET_KEY, undefined);
      return;
    }
    ctx.ui.setWidget(
      MONITOR_WIDGET_KEY,
      (_tui, theme) => createMonitorPanelComponent(
        buildSnapshot,
        () => state.panelMode === "full",
        theme,
      ),
      { placement: "aboveEditor" },
    );
  };

  const setPanelMode = (ctx: ExtensionContext | undefined, mode?: PanelMode) => {
    const prev = state.panelMode;
    const next = mode ?? nextPanelMode(prev);
    state.panelMode = next;
    if ((prev === "collapsed") !== (next === "collapsed")) {
      syncWidget(ctx ?? currentCtx);
    }
    if (next !== "collapsed") {
      refreshSessionCache(ctx ?? currentCtx);
      void refreshGit();
    }
    requestRender();
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
    gitRefreshSeq += 1;
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = undefined;
    }
    splitPaneHandle?.uninstall();
    splitPaneHandle = undefined;
    branchUnsubscribe?.();
    branchUnsubscribe = undefined;
    tasksUnsubscribe?.();
    tasksUnsubscribe = undefined;
    if (currentCtx?.hasUI && currentCtx.mode === "tui") {
      currentCtx.ui.setWidget(MONITOR_WIDGET_KEY, undefined);
      if (restoreFooter) {
        currentCtx.ui.setFooter(undefined);
      }
    }
    state.footerData = undefined;
    currentTui = undefined;
  };

  const mountUi = (ctx: ExtensionContext) => {
    disposeUi(false);
    currentCtx = ctx;
    if (!ctx.hasUI || ctx.mode !== "tui") return;

    ctx.ui.setFooter((tui, theme, footerData) => {
      currentTui = tui;
      state.footerData = footerData;
      const localBranchUnsubscribe = footerData.onBranchChange(() => {
        void refreshGit();
      });
      branchUnsubscribe = localBranchUnsubscribe;

      splitPaneHandle?.uninstall();
      const localSplitHandle = installRightSidebarPatch(
        tui,
        () => resolvePanelMode(state.panelMode) !== "collapsed" && !tui.hasOverlay(),
        (sidebarWidth) => renderMonitorSidebar(
          buildSnapshot(),
          theme,
          sidebarWidth,
          Date.now(),
          state.panelMode === "full",
        ),
        (text) => theme.fg("dim", text),
        (splitActive) => {
          queueMicrotask(() => {
            if (splitPaneHandle !== localSplitHandle) return;
            syncWidget(currentCtx, splitActive);
            requestRender();
          });
        },
      );
      splitPaneHandle = localSplitHandle;

      const component = createMonitorFooterComponent(
        buildSnapshot,
        () => resolvePanelMode(state.panelMode),
        () => setPanelMode(currentCtx),
        theme,
      );
      return {
        ...component,
        dispose() {
          localBranchUnsubscribe();
          if (branchUnsubscribe === localBranchUnsubscribe) {
            branchUnsubscribe = undefined;
          }
          localSplitHandle.uninstall();
          if (splitPaneHandle === localSplitHandle) {
            splitPaneHandle = undefined;
          }
          component.dispose?.();
        },
      };
    });

    syncWidget(ctx);
    state.toolTracker.resetFromEntries(
      ctx.sessionManager.getEntries() as readonly SessionEntryLike[],
    );
    refreshSessionCache(ctx);
    tasksUnsubscribe = services.runtime.tasks.subscribe("*", () => {
      syncTicker();
      requestRender();
    });
    syncTicker();
    void refreshGit();
  };

  pi.registerCommand("gear:panel", {
    description: "Cycle or set workspace monitor panel mode (collapsed, compact, full)",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const normalized = args.trim().toLowerCase();
      const mode: PanelMode | undefined =
        normalized === "full" || normalized === "all" || normalized === "more"
          ? "full"
          : normalized === "on" || normalized === "open" || normalized === "expand" || normalized === "compact"
            ? "compact"
            : normalized === "off" || normalized === "close" || normalized === "collapse" || normalized === "collapsed"
              ? "collapsed"
              : undefined;
      setPanelMode(ctx, mode);
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
    refreshSessionCache(ctx);
    void refreshGit();
    requestRender();
  });

  pi.on("session_compact", (_event, ctx) => {
    currentCtx = ctx;
    refreshSessionCache(ctx);
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
    requestRender();
    if (MUTATING_TOOLS.has(event.toolName)) {
      void refreshGit();
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    currentCtx = ctx;
    refreshSessionCache(ctx);
    syncTicker();
    void refreshGit();
    requestRender();
  });

  pi.on("session_shutdown", () => {
    disposeUi(true);
    currentCtx = undefined;
  });
}
