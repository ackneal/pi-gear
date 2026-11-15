import {
  HStack,
  isViewportTUI,
  ScrollView,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
  type TuiAltScreen,
} from "@earendil-works/pi-tui";

export const SPLIT_MIN_TOTAL_WIDTH = 110;
export const SPLIT_SIDEBAR_MIN_WIDTH = 36;
export const SPLIT_SIDEBAR_MAX_WIDTH = 44;

export function computeSplitWidths(totalWidth: number): {
  splitActive: boolean;
  mainWidth: number;
  sidebarWidth: number;
} {
  if (totalWidth < SPLIT_MIN_TOTAL_WIDTH) {
    return { splitActive: false, mainWidth: totalWidth, sidebarWidth: 0 };
  }
  const target = Math.floor(totalWidth * 0.30);
  const sidebarWidth = Math.max(SPLIT_SIDEBAR_MIN_WIDTH, Math.min(SPLIT_SIDEBAR_MAX_WIDTH, target));
  const mainWidth = totalWidth - sidebarWidth - 3;
  if (mainWidth < 68) {
    return { splitActive: false, mainWidth: totalWidth, sidebarWidth: 0 };
  }
  return { splitActive: true, mainWidth, sidebarWidth };
}

function padToExactWidth(text: string, width: number): string {
  const truncated = visibleWidth(text) > width ? truncateToWidth(text, width, "") : text;
  const pad = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return `${truncated}${pad}`;
}

export interface SplitPaneHandle {
  uninstall(): void;
}

export function installRightSidebarPatch(
  tui: TUI,
  isEnabled: () => boolean,
  renderSidebar: (sidebarWidth: number) => string[],
  dividerColor: (text: string) => string,
  onSplitWidthChange?: (splitActive: boolean, totalWidth: number) => void,
): SplitPaneHandle | undefined {
  if (!isViewportTUI(tui)) {
    return undefined;
  }

  const altTui = tui as unknown as TuiAltScreen;
  const primaryView = (altTui as unknown as { implicitScrollView?: Component }).implicitScrollView;
  if (!primaryView) return undefined;

  let lastSplitActive: boolean | undefined;
  const isSplitVisible = (viewportWidth: number): boolean => {
    const active = isEnabled() && computeSplitWidths(viewportWidth).splitActive;
    if (lastSplitActive !== active) {
      lastSplitActive = active;
      onSplitWidthChange?.(active, viewportWidth);
    }
    return active;
  };

  const sidebarContent: Component = {
    invalidate() {},
    render(width: number): string[] {
      const innerWidth = Math.max(20, width - 2);
      const prefix = dividerColor("│ ");
      return renderSidebar(innerWidth).map((line) => `${prefix}${padToExactWidth(line, innerWidth)}`);
    },
  };

  const sidebarScrollView = new ScrollView(sidebarContent, { follow: "none" });
  const root = new HStack(
    [
      { component: primaryView, grow: 1, shrink: 1, minSize: 68 },
      {
        component: sidebarScrollView,
        basis: SPLIT_SIDEBAR_MAX_WIDTH,
        minSize: SPLIT_SIDEBAR_MIN_WIDTH,
        maxSize: SPLIT_SIDEBAR_MAX_WIDTH,
        visible: (vp) => isSplitVisible(vp.width),
      },
    ],
    { align: "stretch", gap: 1 },
  );

  altTui.setLayoutRoot(root);

  return {
    uninstall() {
      altTui.setLayoutRoot(undefined);
    },
  };
}
