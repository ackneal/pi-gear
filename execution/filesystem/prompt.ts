import { basename } from "node:path";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { CONFIRMATION_TIMEOUT_MS } from "../confirmation-queue.ts";

export type FilesystemPromptChoice =
  | "allow-file-once"
  | "allow-file-session"
  | "allow-project-session"
  | "always-allow-file"
  | "always-allow-project"
  | "deny";

export interface FilesystemPromptParams {
  readonly path: string;
  readonly label: string;
  readonly projectRoot: string | undefined;
  readonly ctx: ExtensionContext;
  readonly signal?: AbortSignal;
}

interface PromptItem {
  readonly label: string;
  readonly choice: FilesystemPromptChoice;
}

export class FilesystemApprovalComponent {
  private selectedIndex = 0;
  private permanent = false;
  private readonly title: string;
  private readonly theme: Theme;
  private readonly requestRender: () => void;
  private readonly done: (choice: FilesystemPromptChoice) => void;
  private readonly itemsTransient: readonly PromptItem[];
  private readonly itemsPermanent: readonly PromptItem[];

  constructor(
    title: string,
    params: { fileLabel: string; projectPattern: string | undefined },
    theme: Theme,
    requestRender: () => void,
    done: (choice: FilesystemPromptChoice) => void,
  ) {
    this.title = title;
    this.theme = theme;
    this.requestRender = requestRender;
    this.done = done;
    const { fileLabel, projectPattern } = params;

    this.itemsTransient = [
      { label: `Allow file once (${fileLabel})`, choice: "allow-file-once" },
      ...(projectPattern !== undefined
        ? [{ label: `Allow project for this session (${projectPattern})`, choice: "allow-project-session" as const }]
        : []),
      { label: "Deny", choice: "deny" },
    ];

    this.itemsPermanent = [
      { label: `Always allow file (${fileLabel})`, choice: "always-allow-file" },
      ...(projectPattern !== undefined
        ? [{ label: `Always allow project (${projectPattern})`, choice: "always-allow-project" as const }]
        : []),
      { label: "Deny", choice: "deny" },
    ];
  }

  get isPermanent(): boolean {
    return this.permanent;
  }

  get items(): readonly PromptItem[] {
    return this.permanent ? this.itemsPermanent : this.itemsTransient;
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.tab)) {
      this.permanent = !this.permanent;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.up) || data === "k") {
      const count = this.items.length;
      this.selectedIndex = (this.selectedIndex - 1 + count) % count;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.down) || data === "j") {
      const count = this.items.length;
      this.selectedIndex = (this.selectedIndex + 1) % count;
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const item = this.items[this.selectedIndex];
      this.done(item?.choice ?? "deny");
      return;
    }

    if (matchesKey(data, Key.escape) || data === "q" || data === "\x03") {
      this.done("deny");
      return;
    }
  }

  render(_width: number): string[] {
    const modeBadge = this.permanent
      ? this.theme.fg("warning", "[Mode: Always Allow (Write to config.json)]")
      : this.theme.fg("muted", "[Mode: Session / Once]");

    const lines: string[] = [
      `${this.title}  ${modeBadge}`,
      "",
    ];

    for (let i = 0; i < this.items.length; i++) {
      const item = this.items[i]!;
      if (i === this.selectedIndex) {
        lines.push(`❯ ${this.theme.fg("accent", item.label)}`);
      } else {
        lines.push(`  ${item.label}`);
      }
    }

    lines.push("");
    const toggleHint = this.permanent
      ? "[Tab] Switch to Session/Once"
      : "[Tab] Switch to Always Allow";
    lines.push(this.theme.fg("dim", `${toggleHint} • [↑/↓] Select • [Enter] Confirm • [Esc] Deny`));

    return lines;
  }
}

export const promptFilesystemAccess = async (params: FilesystemPromptParams): Promise<FilesystemPromptChoice> => {
  const { path, label, projectRoot, ctx, signal } = params;
  const fileLabel = basename(path);
  const projectPattern = projectRoot !== undefined
    ? `${projectRoot.replace(/\/+$/, "")}/**`
    : undefined;
  const title = `Allow ${label} access to ${path}?`;

  if (ctx.mode === "tui" && typeof ctx.ui?.custom === "function") {
    return ctx.ui.custom<FilesystemPromptChoice>((tui, theme, _keybindings, done) => {
      const onAbort = () => done("deny");
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();

      const component = new FilesystemApprovalComponent(
        title,
        { fileLabel, projectPattern },
        theme,
        () => tui.requestRender(),
        done,
      );

      return Object.assign(component, {
        dispose: () => signal?.removeEventListener("abort", onAbort),
      });
    });
  }

  if (typeof ctx.ui?.select === "function") {
    const options = [
      `Allow file once (${fileLabel})`,
      ...(projectPattern !== undefined ? [`Allow project for this session (${projectPattern})`] : []),
      ...(projectPattern !== undefined ? [`Always allow project (${projectPattern})`] : []),
      `Always allow file (${fileLabel})`,
      "Deny",
    ];

    const dialogOptions = signal !== undefined
      ? { timeout: CONFIRMATION_TIMEOUT_MS, signal }
      : { timeout: CONFIRMATION_TIMEOUT_MS };

    const choice = await ctx.ui.select(title, options, dialogOptions);

    if (choice === `Allow file once (${fileLabel})`) return "allow-file-once";
    if (projectPattern !== undefined && choice === `Allow project for this session (${projectPattern})`) return "allow-project-session";
    if (projectPattern !== undefined && choice === `Always allow project (${projectPattern})`) return "always-allow-project";
    if (choice === `Always allow file (${fileLabel})`) return "always-allow-file";
    return "deny";
  }

  const dialogOptions = signal !== undefined
    ? { timeout: CONFIRMATION_TIMEOUT_MS, signal }
    : { timeout: CONFIRMATION_TIMEOUT_MS };
  const allowed = await ctx.ui.confirm("Outside workspace access", title, dialogOptions);
  return allowed ? "allow-file-once" : "deny";
};
