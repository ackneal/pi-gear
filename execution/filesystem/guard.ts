import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import type { FilesystemOperation } from "../policy/filesystem.ts";
import { ConfirmationQueue } from "../confirmation-queue.ts";
import { FilesystemAccess, type FilesystemAccessOptions } from "./access.ts";

type GuardedTool = "read" | "edit" | "write";

const filesystemOperations = {
  read: "read",
  edit: "write",
  write: "write",
} as const satisfies Record<GuardedTool, FilesystemOperation>;

type GuardedToolEvent = ToolCallEvent & {
  toolName: GuardedTool;
  input: { path?: string };
};

const block = (operation: string, path: string, reason: string, ctx: ExtensionContext) => {
  if (ctx.hasUI) ctx.ui.notify(`Blocked ${operation} on ${path}`, "warning");
  return { block: true as const, reason };
};

export interface FilesystemAccessService {
  forWorkspace(cwd: string): FilesystemAccess;
}

export function setupFilesystemGuard(
  pi: ExtensionAPI,
  options: FilesystemAccessOptions = {},
): FilesystemAccessService {
  const workspaces = new Map<string, FilesystemAccess>();
  const confirmationQueue = options.confirmationQueue ?? new ConfirmationQueue();
  const accessOptions = { ...options, confirmationQueue };
  const forWorkspace = (cwd: string): FilesystemAccess => {
    let access = workspaces.get(cwd);
    if (access === undefined) {
      access = new FilesystemAccess(cwd, accessOptions);
      workspaces.set(cwd, access);
    }
    return access;
  };

  pi.on("tool_call", async (event, ctx) => {
    if (!Object.hasOwn(filesystemOperations, event.toolName)) {
      if (isToolCallEventType("bash", event)) return;
      return;
    }

    const guarded = event as GuardedToolEvent;
    const path = guarded.input.path ?? ".";
    const operation = filesystemOperations[guarded.toolName];
    try {
      const access = forWorkspace(ctx.cwd);
      const authorization = await access.request(path, operation, guarded.toolName, ctx, pi);
      guarded.input.path = authorization.path;
      if (authorization.decision === "deny") {
        return block(guarded.toolName, authorization.path, "Access is not permitted.", ctx);
      }
      if (authorization.decision === "ask") {
        return block(guarded.toolName, authorization.path, "Access outside the workspace requires confirmation.", ctx);
      }
    } catch {
      return block(guarded.toolName, path, "File access policy is unavailable.", ctx);
    }
  });

  const clear = (): void => {
    confirmationQueue.reset();
    workspaces.clear();
  };
  pi.on("session_before_switch", clear);
  pi.on("session_shutdown", clear);

  return { forWorkspace };
}
