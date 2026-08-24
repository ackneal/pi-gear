import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SandboxController, type SandboxStatus } from "./controller.ts";
import { createSandboxBashTool } from "../../ui/tools/index.ts";

export interface SandboxDiagnostics {
  status(): SandboxStatus;
}

export function setupSandbox(pi: ExtensionAPI): SandboxDiagnostics {
  const controller = new SandboxController((content) =>
    pi.sendMessage({ customType: "sandbox", content, display: false }),
  );
  pi.on("session_start", async (_event, ctx) => controller.start(ctx));
  pi.on("session_shutdown", async () => {
    await controller.shutdown();
  });

  pi.on("user_bash", () => ({ operations: controller.operations }));
  pi.on("session_start", (_event, ctx) => {
    pi.registerTool(createSandboxBashTool(ctx.cwd, controller.operations));
  });

  return {
    status: () => controller.status(),
  };
}
