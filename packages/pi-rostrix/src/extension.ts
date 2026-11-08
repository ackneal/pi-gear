import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initRoster } from "./index.ts";

export default function rosterExtension(pi: ExtensionAPI): void {
  initRoster(pi, { autoRegisterTools: true });
}
