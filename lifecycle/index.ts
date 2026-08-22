import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearSubagentRegistry } from "../ui/subagent/detail/registry.ts";
import { setupLoopGuard } from "./loop.ts";

export function setupLifecycle(pi: ExtensionAPI): void {
  setupLoopGuard(pi);

  pi.on("session_start", () => {
    clearSubagentRegistry();
  });

  pi.on("session_before_switch", () => {
    clearSubagentRegistry();
  });

  pi.on("session_shutdown", () => {
    clearSubagentRegistry();
  });
}
