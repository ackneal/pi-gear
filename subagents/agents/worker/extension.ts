import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "../../../config/index.ts";
import { setupFilesystemGuard } from "../../../execution/filesystem/guard.ts";
import { setupSandbox } from "../../../execution/sandbox/index.ts";
import { setupWorkspace } from "../../../workspace/setup.ts";

export default async function workerExtension(
  pi: ExtensionAPI,
  loadConfig = loadExtensionConfig,
): Promise<void> {
  const config = await loadConfig();
  const filesystem = setupFilesystemGuard(pi);
  setupWorkspace(pi, filesystem);
  setupSandbox(pi, config);
}
