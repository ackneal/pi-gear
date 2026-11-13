import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { McpCapabilitySpec } from "./types.ts";

export function setupMcpCapabilities(pi: ExtensionAPI, specs: readonly McpCapabilitySpec[]): void {
  for (const spec of specs) {
    pi.registerMcpServer(spec.id, {
      url: spec.endpoint,
      exposure: "hidden",
      toolExposure: Object.fromEntries(spec.tools.map((tool) => [tool.name, "direct" as const])),
    });
  }
}
