import { ExtensionEditorComponent, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";

export async function editCommand(
  ctx: ExtensionToolContext,
  command: string,
  signal: AbortSignal,
): Promise<string | undefined> {
  if (ctx.mode !== "tui") {
    throw new Error("Editing commands requires terminal UI. Request a revised command instead.");
  }
  if (signal.aborted) return undefined;

  let cleanup = (): void => {};
  try {
    return await ctx.ui.custom<string | undefined>((tui, _theme, keybindings, done) => {
      let stopped = false;
      let finished = false;
      let pending: { value: string | undefined } | undefined;
      const dispose = (): void => {
        finished = true;
        signal.removeEventListener("abort", abort);
      };
      const finish = (value: string | undefined): void => {
        if (finished) return;
        if (stopped) {
          pending = { value };
          return;
        }
        dispose();
        done(signal.aborted ? undefined : value);
      };
      const abort = (): void => finish(undefined);
      cleanup = dispose;

      // Only the native editor uses this proxy. Cancellation cannot return UI
      // ownership until its child has exited and the real TUI has restarted.
      const editorTui = new Proxy(tui, {
        get(target, key) {
          if (key === "stop") return () => {
            target.stop();
            stopped = true;
          };
          if (key === "start") return () => {
            target.start();
            stopped = false;
            if (pending) finish(pending.value);
          };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const editor = new ExtensionEditorComponent(editorTui, keybindings, "Edit command", command, finish, abort);
      signal.addEventListener("abort", abort, { once: true });
      // ui.custom may invoke its factory after the signal was cancelled.
      if (signal.aborted) abort();
      return Object.assign(editor, { dispose });
    });
  } finally {
    cleanup();
  }
}
