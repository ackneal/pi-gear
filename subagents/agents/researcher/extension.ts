import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupMcpCapabilities } from "../../../capabilities/index.ts";
import type { McpCapabilitySpec } from "../../../capabilities/mcp/types.ts";
import { setupFilesystemGuard } from "../../../execution/filesystem/guard.ts";
import { setupWorkspace } from "../../../workspace/setup.ts";
import { researcherProfile } from "./profile.ts";

const mcpCapabilities = researcherProfile.capabilities.filter((capability): capability is McpCapabilitySpec => capability.kind === "mcp");
export default async function researcherExtension(pi: ExtensionAPI): Promise<void> {
  const filesystem = setupFilesystemGuard(pi);
  setupWorkspace(pi, filesystem);
  await setupMcpCapabilities(pi, mcpCapabilities);
}
