import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "../../config/index.ts";
import { SandboxController, type SandboxStatus } from "./controller.ts";
import { createSandboxBashTool } from "../../ui/tools/index.ts";

export interface SandboxDiagnostics {
  status(): SandboxStatus;
}

const disabledStatus: SandboxStatus = Object.freeze({
  configured: false,
  enabled: false,
  workspace: "host",
  reason: undefined,
  network: undefined,
});

export function setupSandbox(
  pi: ExtensionAPI,
  config: ExtensionConfig,
  createController: (send: (content: string) => void | Promise<void>) => SandboxController =
    (send) => new SandboxController(send),
): SandboxDiagnostics {
  if (!config.sandbox.enabled) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) {
        ctx.ui.notify(
          "pi-gear sandbox is disabled. Bash commands run directly on the host.",
          "warning",
        );
      }
    });
    return { status: () => disabledStatus };
  }

  const controller = createController((content) =>
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
