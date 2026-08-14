import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupFilesystemGuard } from "./filesystem/guard.ts";
import { setupSandbox } from "./sandbox/index.ts";
import { setupFileToolUi } from "../ui/tools/index.ts";

export function setupExecution(pi: ExtensionAPI): void {
  setupFilesystemGuard(pi);
  setupSandbox(pi);
  setupFileToolUi(pi);
}
