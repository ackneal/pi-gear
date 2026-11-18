import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import type { Runtime } from "pi-rostrix";
import { createMonitorFooterComponent } from "./footer.ts";
import { readWorkspaceGitSnapshot } from "./git-status.ts";
import {
  createMonitorState,
  summarizeSessionUsage,
  type MonitorSnapshot,
  type SessionEntryLike,
  type SessionUsageSnapshot,
} from "./state.ts";

export interface WorkspaceMonitorServices {
  readonly runtime: Runtime;
}

const MUTATING_TOOLS = new Set(["write", "edit", "bash"]);

export function setupWorkspaceMonitor(
  pi: ExtensionAPI,
  services: WorkspaceMonitorServices,
): void {
  const state = createMonitorState();
  let currentCtx: ExtensionContext | undefined;
  let currentTui: TUI | undefined;
  let branchUnsubscribe: (() => void) | undefined;
  let tasksUnsubscribe: (() => void) | undefined;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let gitRefreshSeq = 0;
  let cachedActiveAgentId = "default";
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
    cachedActiveAgentId = services.runtime.getActiveAgent()?.id ?? "default";
    if (!ctx) return;

    const entries = ctx.sessionManager.getEntries() as readonly SessionEntryLike[];
    cachedSessionUsage = summarizeSessionUsage(
      entries,
      ctx.getContextUsage(),
      ctx.model?.contextWindow ?? 0,
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
    branchUnsubscribe?.();
    branchUnsubscribe = undefined;
    tasksUnsubscribe?.();
    tasksUnsubscribe = undefined;
    if (currentCtx?.hasUI && currentCtx.mode === "tui") {
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

      const component = createMonitorFooterComponent(buildSnapshot, theme);
      return {
        ...component,
        dispose() {
          localBranchUnsubscribe();
          if (branchUnsubscribe === localBranchUnsubscribe) {
            branchUnsubscribe = undefined;
          }
          component.dispose?.();
        },
      };
    });

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
