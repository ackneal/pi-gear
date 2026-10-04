import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupMcpCapabilities } from "../../../capabilities/index.ts";
import type { McpCapabilitySpec } from "../../../capabilities/mcp/types.ts";
import { researcherProfile } from "./profile.ts";

const mcpCapabilities = researcherProfile.capabilities.filter((capability): capability is McpCapabilitySpec => capability.kind === "mcp");
export default function researcherExtension(pi: ExtensionAPI): void {
  setupMcpCapabilities(pi, mcpCapabilities);
}
