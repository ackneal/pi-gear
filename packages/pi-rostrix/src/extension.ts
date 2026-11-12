import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { init } from "./index.ts";

export default function rostrixExtension(pi: ExtensionAPI): void {
  init(pi, {
    autoRegisterTaskTools: true,
    autoLoadDefinitions: true,
    autoRegisterAgentControls: true,
  });
}
