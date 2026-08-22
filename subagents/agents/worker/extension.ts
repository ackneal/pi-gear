import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupFilesystemGuard } from "../../../execution/filesystem/guard.ts";
import { setupSandbox } from "../../../execution/sandbox/index.ts";

export default function workerExtension(pi: ExtensionAPI): void {
  setupFilesystemGuard(pi);
  setupSandbox(pi);
}
