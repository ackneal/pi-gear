import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupLoopGuard } from "./loop.ts";

export function setupLifecycle(pi: ExtensionAPI): void {
  setupLoopGuard(pi);
}
