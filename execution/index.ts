import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "../config/index.ts";
import { setupFilesystemGuard, type FilesystemAccessService } from "./filesystem/guard.ts";
import { setupHostCommand } from "./host-command.ts";
import { setupSandbox, type SandboxDiagnostics } from "./sandbox/index.ts";
import { setupFileToolUi } from "../ui/tools/index.ts";
import { ConfirmationQueue } from "./confirmation-queue.ts";

export interface ExecutionServices {
  sandbox: SandboxDiagnostics;
  filesystem: FilesystemAccessService;
}

export interface ExecutionOptions {
  readonly child?: boolean;
}

export function setupExecution(pi: ExtensionAPI, config: ExtensionConfig, options: ExecutionOptions = {}): ExecutionServices {
  const confirmationQueue = new ConfirmationQueue();
  const filesystem = setupFilesystemGuard(pi, { confirmationQueue });
  const sandbox = setupSandbox(pi, config, { confirmationQueue });
  if (!options.child && config.sandbox.enabled) {
    setupHostCommand(pi, { confirmationQueue });
  }
  setupFileToolUi(pi);

  return { sandbox, filesystem };
}
