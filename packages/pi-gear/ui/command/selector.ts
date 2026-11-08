import type { ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { CONFIRMATION_TIMEOUT_MS } from "../../execution/confirmation-queue.ts";
import { commandApprovalPrompt } from "./approval.ts";

export async function selectCommand(
  ctx: ExtensionToolContext,
  command: string,
  reason: string | undefined,
  directory: string | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  const deadline = Date.now() + CONFIRMATION_TIMEOUT_MS;
  const resized = Symbol("selector resized");

  while (!signal.aborted && Date.now() < deadline) {
    const controller = new AbortController();
    const resize = () => controller.abort(resized);
    const selectionSignal = ctx.mode === "tui"
      ? AbortSignal.any([signal, controller.signal])
      : signal;

    if (ctx.mode === "tui") process.stdout.on("resize", resize);
    try {
      const { title } = ctx.mode === "tui"
        ? commandApprovalPrompt(command, reason, directory)
        : { title: ["Run command?", reason, [directory, `$ ${command}`].filter(Boolean).join("\n")].filter(Boolean).join("\n\n") };
      const timeout = deadline - Date.now();
      if (signal.aborted || timeout <= 0) return undefined;
      const choice = await ctx.ui.select(title, ["Run", "Edit", "Cancel"], {
        timeout,
        signal: selectionSignal,
      });

      // A choice from the old layout is never authorization, even if it won
      // the native promise race against resize cancellation.
      if (signal.aborted || Date.now() >= deadline) return undefined;
      if (controller.signal.reason === resized) continue;
      return choice;
    } finally {
      if (ctx.mode === "tui") process.stdout.removeListener("resize", resize);
    }
  }
  return undefined;
}
