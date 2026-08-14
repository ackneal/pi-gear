import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SandboxController, type SandboxStatus } from "./controller.ts";
import { createSandboxBashTool } from "../../ui/tools/index.ts";

/** Pi adapter: register the controller's lifecycle, bash operations, and status surface. */
export function formatDoctor(status: SandboxStatus, platform: NodeJS.Platform = process.platform): string {
  const lines = [
    `Sandbox: ${status.enabled ? "enabled" : "unavailable"}`,
    `Platform: ${platform}`,
    `Workspace: ${status.workspace}`,
    "Filesystem: read/edit/write guarded; other tools warn when unguarded",
    "Network: configured rules; unknown hosts require approval",
  ];
  if (!status.enabled && status.reason !== undefined) lines.splice(1, 0, `Reason: ${status.reason}`);
  return lines.join("\n");
}

export function setupSandbox(pi: ExtensionAPI): void {
  const controller = new SandboxController((content) =>
    pi.sendMessage({ customType: "sandbox", content, display: false }),
  );
  pi.on("session_start", async (_event, ctx) => controller.start(ctx));
  pi.on("session_shutdown", async () => {
    await controller.shutdown();
  });

  pi.on("user_bash", () => ({ operations: controller.operations }));
  pi.registerTool(createSandboxBashTool(process.cwd(), controller.operations));
  pi.on("session_start", (_event, ctx) => {
    pi.registerTool(createSandboxBashTool(ctx.cwd, controller.operations));
  });

  pi.registerCommand("doctor", {
    description: "Show pi-gear runtime diagnostics",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatDoctor(controller.status()), "info");
    },
  });
}
