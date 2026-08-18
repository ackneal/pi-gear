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
  if (typeof ctx.ui?.setWidget === "function") {
    ctx.ui.setWidget("__tui_clear_on_shrink", (tui) => {
      if (typeof (tui as unknown as { setClearOnShrink?: (val: boolean) => void }).setClearOnShrink === "function") {
        (tui as unknown as { setClearOnShrink: (val: boolean) => void }).setClearOnShrink(true);
      }
      return { render: () => [], invalidate: () => {} };
    });
  }

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
      if (typeof (tui as unknown as { setClearOnShrink?: (val: boolean) => void }).setClearOnShrink === "function") {
        (tui as unknown as { setClearOnShrink: (val: boolean) => void }).setClearOnShrink(true);
      }

      let unsubscribe: (() => void) | undefined;

      const component = new SubagentDetailComponent({
        entry: entryToDisplay,
        theme,
        onClose: () => done(undefined),
        invalidate: () => tui.requestRender(),
      });

      unsubscribe = subscribeSubagent(entryToDisplay.toolCallId, (run) => {
        component.update(run);
      });

      return {
        render: (width: number) => component.render(width),
        handleInput: (data: string) => component.handleInput(data),
        invalidate: () => component.invalidate(),
        dispose: () => {
          unsubscribe?.();
          component.dispose();
          if (typeof (tui as unknown as { setClearOnShrink?: (val: boolean) => void }).setClearOnShrink === "function") {
            (tui as unknown as { setClearOnShrink: (val: boolean) => void }).setClearOnShrink(true);
          }
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
