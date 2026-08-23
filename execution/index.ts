import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupFilesystemGuard } from "./filesystem/guard.ts";
import { setupSandbox, type SandboxDiagnostics } from "./sandbox/index.ts";
import { setupFileToolUi } from "../ui/tools/index.ts";

export interface ExecutionServices {
  sandbox: SandboxDiagnostics;
}

export function setupExecution(pi: ExtensionAPI): ExecutionServices {
  setupFilesystemGuard(pi);
  const sandbox = setupSandbox(pi);
  setupFileToolUi(pi);

  return { sandbox };
}
