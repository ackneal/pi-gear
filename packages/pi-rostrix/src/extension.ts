import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initRuntime } from "./index.ts";

export default function rostrixExtension(pi: ExtensionAPI): void {
  initRuntime(pi, {
    autoRegisterTaskTools: true,
    autoLoadDefinitions: true,
    autoRegisterAgentControls: true,
  });
}
