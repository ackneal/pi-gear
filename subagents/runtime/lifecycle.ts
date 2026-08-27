import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface SubagentSessionRuntime {
  beginSession(): void;
  shutdown(): Promise<void>;
}

export function setupSubagentRuntimeLifecycle(pi: ExtensionAPI, runtime: SubagentSessionRuntime): void {
  pi.on("session_start", () => runtime.beginSession());
  pi.on("session_shutdown", () => runtime.shutdown());
}
