import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ExtensionConfig } from "../../config/index.ts";
import { SandboxController, type SandboxStatus } from "./controller.ts";
import { createSandboxBashTool } from "../../ui/tools/index.ts";
import { ConfirmationQueue } from "../confirmation-queue.ts";

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

export interface SandboxSetupOptions {
  readonly confirmationQueue?: ConfirmationQueue;
  readonly createController?: (send: (content: string) => void | Promise<void>) => SandboxController;
}

export function setupSandbox(
  pi: ExtensionAPI,
  config: ExtensionConfig,
  options: SandboxSetupOptions = {},
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

  const confirmationQueue = options.confirmationQueue ?? new ConfirmationQueue();
  const createController = options.createController ?? ((send) => new SandboxController(send, undefined, undefined, confirmationQueue));
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
