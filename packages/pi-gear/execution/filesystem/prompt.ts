import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIRMATION_TIMEOUT_MS } from "../confirmation-queue.ts";

export type FilesystemPromptChoice =
  | "allow-file"
  | "allow-project"
  | "always-allow-file"
  | "always-allow-project"
  | "deny";

export interface FilesystemPromptParams {
  readonly path: string;
  readonly label: string;
  readonly projectPattern: string | undefined;
  readonly ctx: ExtensionContext;
  readonly signal?: AbortSignal;
}

export const promptFilesystemAccess = async (params: FilesystemPromptParams): Promise<FilesystemPromptChoice> => {
  if (params.signal?.aborted) return "deny";

  const { path, label, projectPattern, ctx, signal } = params;
  const title = `Allow ${label} access to ${path}? (Approved access applies to this session)`;

  const dialogOptions = signal !== undefined
    ? { timeout: CONFIRMATION_TIMEOUT_MS, signal }
    : { timeout: CONFIRMATION_TIMEOUT_MS };

  if (typeof ctx.ui?.select === "function") {
    const options = projectPattern !== undefined
      ? [
          "Allow",
          `Allow project (${projectPattern})`,
          "Always allow project",
          "Deny",
        ]
      : [
          "Allow",
          "Always allow",
          "Deny",
        ];

    const choice = await ctx.ui.select(title, options, dialogOptions);

    if (choice === "Allow") return "allow-file";
    if (projectPattern !== undefined && choice === `Allow project (${projectPattern})`) return "allow-project";
    if (projectPattern !== undefined && choice === "Always allow project") return "always-allow-project";
    if (projectPattern === undefined && choice === "Always allow") return "always-allow-file";
    return "deny";
  }

  const allowed = await ctx.ui.confirm("Outside workspace access", title, dialogOptions);
  return allowed ? "allow-file" : "deny";
};
