import {
  isToolCallEventType,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolCallEvent,
} from "@earendil-works/pi-coding-agent";
import {
  evaluateFilesystem,
  followFallbackAccess,
  mostRestrictiveFilesystemDecision,
  type FilesystemOperation,
} from "../policy/filesystem.ts";
import { loadExtensionConfig } from "../../config/index.ts";
import {
  canonicalizeWorkspace,
  normalizeToolPath,
  resolveAccessTarget,
  selectReadPath,
  type CanonicalWorkspace,
} from "./paths.ts";

type GuardedTool = "read" | "edit" | "write";

const filesystemOperations = {
  read: "read",
  edit: "write",
  write: "write",
} as const satisfies Record<GuardedTool, FilesystemOperation>;

type GuardedToolEvent = ToolCallEvent & {
  toolName: GuardedTool;
  input: { path: string };
};

const ask = async (
  operation: string,
  path: string,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): Promise<{ block: true; reason: string } | undefined> => {
  const sendDecision = (content: string): void => {
    pi.sendMessage({ customType: "filesystem", content, display: false });
  };

  const reason = "Access outside the workspace requires confirmation.";
  if (!ctx.hasUI) return { block: true, reason };

  const allowed = await ctx.ui.confirm(
    "Outside workspace access",
    `Allow ${operation} on ${path}?`,
  );
  if (allowed) {
    sendDecision(`User approved outside-workspace access: ${operation} ${path}`);
    return undefined;
  }

  sendDecision(`User denied outside-workspace access: ${operation} ${path}`);
  return block(
    operation,
    path,
    "Access outside the workspace was denied by user.",
    ctx,
  );
};

const block = (
  operation: string,
  path: string,
  reason: string,
  ctx: ExtensionContext,
) => {
  if (ctx.hasUI) {
    ctx.ui.notify(`Blocked ${operation} on ${path}`, "warning");
  }
  return { block: true as const, reason };
};

export function setupFilesystemGuard(pi: ExtensionAPI): void {
  const workspaces = new Map<string, Promise<CanonicalWorkspace>>();
  const warnedTools = new Set<string>();

  const workspaceFor = (cwd: string): Promise<CanonicalWorkspace> => {
    let workspace = workspaces.get(cwd);
    if (workspace === undefined) {
      workspace = canonicalizeWorkspace(cwd);
      workspaces.set(cwd, workspace);
    }
    return workspace;
  };

  const guard = async (event: GuardedToolEvent, ctx: ExtensionContext) => {
    const toolName = event.toolName;
    const path = event.input.path;
    const operation = filesystemOperations[toolName];

    try {
      const [config, workspace] = await Promise.all([
        loadExtensionConfig(),
        workspaceFor(ctx.cwd),
      ]);
      const normalizedPath = normalizeToolPath(path, workspace.cwd);
      const targetPath = operation === "read"
        ? await selectReadPath(normalizedPath)
        : normalizedPath;

      event.input.path = targetPath;

      const target = await resolveAccessTarget(targetPath, workspace);
      const decision = mostRestrictiveFilesystemDecision([
        evaluateFilesystem(
          config,
          workspace.cwd,
          target.path,
          operation,
        ),
        evaluateFilesystem(
          config,
          workspace.canonicalRoot,
          target.canonicalPath,
          operation,
          // A follow:true rule authorizes the resolved target too; deny rules
          // on the target still outrank it inside the canonical evaluation.
          followFallbackAccess(config, workspace.cwd, target.path),
        ),
      ]);

      switch (decision) {
        case "deny":
          return block(toolName, target.path, "Access is not permitted.", ctx);
        case "ask":
          return ask(toolName, target.path, ctx, pi);
        case "allow":
          return;
      }
    } catch {
      return block(toolName, path, "File access policy is unavailable.", ctx);
    }
  };

  pi.on("tool_call", async (event, ctx) => {
    if (Object.hasOwn(filesystemOperations, event.toolName)) {
      return guard(event as GuardedToolEvent, ctx);
    }

    // Sandboxed Bash has a boundary outside this policy.
    if (isToolCallEventType("bash", event)) return;

    // Recursive filesystem tools are unguarded; if Pi ever enables them,
    // surface that instead of letting them pass silently.
    if (
      isToolCallEventType("grep", event) ||
      isToolCallEventType("find", event) ||
      isToolCallEventType("ls", event)
    ) {
      if (ctx.hasUI && !warnedTools.has(event.toolName)) {
        warnedTools.add(event.toolName);
        ctx.ui.notify(
          `${event.toolName} is not covered by the filesystem policy.`,
          "warning",
        );
      }
    }

    return;
  });

  pi.on("session_start", () => warnedTools.clear());
}
