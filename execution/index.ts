import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "../config/index.ts";
import { setupFilesystemGuard, type FilesystemAccessService } from "./filesystem/guard.ts";
import { setupSandbox, type SandboxDiagnostics } from "./sandbox/index.ts";
import { setupFileToolUi } from "../ui/tools/index.ts";

export interface ExecutionServices {
  sandbox: SandboxDiagnostics;
  filesystem: FilesystemAccessService;
}

export function setupExecution(pi: ExtensionAPI, config: ExtensionConfig): ExecutionServices {
  const filesystem = setupFilesystemGuard(pi);
  const sandbox = setupSandbox(pi, config);
  setupFileToolUi(pi);

  return { sandbox, filesystem };
}
