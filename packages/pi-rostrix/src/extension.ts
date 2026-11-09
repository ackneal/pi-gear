import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initRostrix } from "./index.ts";

export default function rostrixExtension(pi: ExtensionAPI): void {
  initRostrix(pi, {
    autoRegisterTools: true,
    autoLoadProfiles: true,
    autoRegisterInteractive: true,
  });
}
