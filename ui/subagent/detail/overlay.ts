import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SubagentDetailComponent } from "./component.ts";
import { formatDuration, titleCase } from "./format.ts";
import {
  getAllSubagentEntries,
  getSubagentEntry,
  subscribeSubagent,
  type SubagentViewEntry,
} from "./registry.ts";

export async function openSubagentDetailOverlay(
  ctx: ExtensionContext,
  toolCallId?: string,
): Promise<void> {
  let targetEntry: SubagentViewEntry | undefined;

  if (toolCallId) {
    targetEntry = getSubagentEntry(toolCallId);
    if (!targetEntry) {
      ctx.ui.notify(`Subagent run '${toolCallId}' not found.`, "error");
      return;
    }
  } else {
    const entries = getAllSubagentEntries();
    if (entries.length === 0) {
      ctx.ui.notify("No subagents recorded in session.", "info");
      return;
    }

    if (entries.length === 1) {
      targetEntry = entries[0];
    } else {
      const reversed = [...entries].reverse();
      const options = reversed.map((e) => {
        const label = titleCase(e.profile.label || e.profile.id || "Subagent");
        const statusText =
          e.run.status === "success"
            ? "Complete"
            : e.run.status === "error"
              ? "Failed"
              : e.run.status === "aborted"
                ? "Aborted"
                : "Running";
        const elapsed = Math.max(0, (e.run.finishedAt ?? Date.now()) - e.run.startedAt);
        const dur = formatDuration(elapsed);
        const shortTask =
          e.task.length > 50 ? `${e.task.slice(0, 49)}…` : e.task;
        return `${label} · ${statusText} (${dur}) — ${shortTask}`;
      });

      const choice = await ctx.ui.select("Select Subagent Run", options);
      if (!choice) return;

      const selectedIndex = options.indexOf(choice);
      targetEntry =
        selectedIndex >= 0 ? reversed[selectedIndex] : entries[entries.length - 1];
    }
  }

  if (!targetEntry) return;
  const entryToDisplay = targetEntry;

  await ctx.ui.custom(
    (tui, theme, _keybindings, done) => {
      const clearable = tui as unknown as {
        getClearOnShrink?: () => boolean;
        setClearOnShrink?: (value: boolean) => void;
      };
      const previousClearOnShrink = clearable.getClearOnShrink?.();
      clearable.setClearOnShrink?.(true);
      let restored = false;
      const restore = () => {
        if (restored) return;
        restored = true;
        if (previousClearOnShrink !== undefined) clearable.setClearOnShrink?.(previousClearOnShrink);
      };

      const allEntries = getAllSubagentEntries();
      const startIndex = Math.max(
        0,
        allEntries.findIndex((e) => e.toolCallId === entryToDisplay.toolCallId),
      );
      const component = new SubagentDetailComponent({
        entry: entryToDisplay,
        theme,
        onClose: () => {
          restore();
          done(undefined);
        },
        invalidate: () => tui.requestRender(),
        entries: allEntries,
        index: startIndex,
        subscribe: subscribeSubagent,
      });

      return {
        render: (width: number) => component.render(width),
        handleInput: (data: string) => component.handleInput(data),
        invalidate: () => component.invalidate(),
        dispose: () => {
          restore();
          component.dispose();
          tui.requestRender();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        width: "100%",
        maxHeight: "100%",
        anchor: "center",
        margin: 0,
      },
    },
  );
}
