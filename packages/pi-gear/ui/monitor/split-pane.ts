import { truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";

const SEGMENT_RESET = "\x1b[0m\x1b]8;;\x07";
const DIVIDER = " │ ";
const DIVIDER_WIDTH = 3;

export const SPLIT_MIN_TOTAL_WIDTH = 110;
export const SPLIT_SIDEBAR_MIN_WIDTH = 36;
export const SPLIT_SIDEBAR_MAX_WIDTH = 44;

function isImageLine(line: string): boolean {
  return line.includes("\x1b_G") || line.includes("\x1b]1337;File=");
}

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
  const mainWidth = totalWidth - sidebarWidth - DIVIDER_WIDTH;
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

export function composeSideBySideLines(
  mainLines: readonly string[],
  sidebarLines: readonly string[],
  mainWidth: number,
  sidebarWidth: number,
  termHeight: number,
  dividerColor: (text: string) => string = (text) => text,
): string[] {
  const totalWidth = mainWidth + DIVIDER_WIDTH + sidebarWidth;
  const result = [...mainLines];
  const viewportTop = Math.max(0, result.length - Math.max(1, termHeight));
  const requiredLength = viewportTop + sidebarLines.length;
  while (result.length < requiredLength) {
    result.push("");
  }

  const styledDivider = dividerColor(DIVIDER);
  const emptySidebar = " ".repeat(sidebarWidth);

  for (let i = 0; i < result.length; i += 1) {
    const leftLine = result[i] ?? "";
    if (isImageLine(leftLine)) continue;

    const sidebarIndex = i - viewportTop;
    const rightRaw = sidebarIndex >= 0 && sidebarIndex < sidebarLines.length
      ? (sidebarLines[sidebarIndex] ?? "")
      : emptySidebar;
    const rightLine = padToExactWidth(rightRaw, sidebarWidth);
    const leftPadded = padToExactWidth(leftLine, mainWidth);
    const combined = `${leftPadded}${SEGMENT_RESET}${styledDivider}${rightLine}${SEGMENT_RESET}`;
    result[i] = visibleWidth(combined) <= totalWidth
      ? combined
      : truncateToWidth(combined, totalWidth, "");
  }

  return result;
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
): SplitPaneHandle {
  const hadOwn = Object.prototype.hasOwnProperty.call(tui, "render");
  const originalRender = tui.render;
  let lastSplitActive: boolean | undefined;

  const patchedRender = (width: number): string[] => {
    const { splitActive, mainWidth, sidebarWidth } = isEnabled()
      ? computeSplitWidths(width)
      : { splitActive: false, mainWidth: width, sidebarWidth: 0 };

    if (lastSplitActive !== splitActive) {
      lastSplitActive = splitActive;
      onSplitWidthChange?.(splitActive, width);
    }

    if (!splitActive) {
      return originalRender.call(tui, width);
    }

    const mainLines = originalRender.call(tui, mainWidth);
    const sidebarLines = renderSidebar(sidebarWidth);
    const termHeight = tui.terminal.rows || mainLines.length;
    return composeSideBySideLines(
      mainLines,
      sidebarLines,
      mainWidth,
      sidebarWidth,
      termHeight,
      dividerColor,
    );
  };

  tui.render = patchedRender;

  return {
    uninstall() {
      if (tui.render === patchedRender) {
        if (hadOwn) {
          tui.render = originalRender;
        } else {
          delete (tui as Partial<TUI>).render;
        }
      }
    },
  };
}
