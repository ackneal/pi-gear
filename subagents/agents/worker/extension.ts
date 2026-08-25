import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "../../../config/index.ts";
import { setupFilesystemGuard } from "../../../execution/filesystem/guard.ts";
import { setupSandbox } from "../../../execution/sandbox/index.ts";

export default async function workerExtension(
  pi: ExtensionAPI,
  loadConfig = loadExtensionConfig,
): Promise<void> {
  const config = await loadConfig();
  setupFilesystemGuard(pi);
  setupSandbox(pi, config);
}
