import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearSubagentRegistry } from "../ui/subagent/detail/registry.ts";
import { setupLoopGuard } from "./loop.ts";
import { FffSidecar } from "./fff.ts";
import type { FffClient } from "./fff-client.ts";

export interface LifecycleServices {
  readonly fff: {
    current(cwd?: string): FffClient | undefined;
    endpoint(cwd?: string): string | undefined;
  };
}

export function setupLifecycle(pi: ExtensionAPI): LifecycleServices {
  setupLoopGuard(pi);
  let resource: FffSidecar | undefined;

  const stopFff = async (): Promise<void> => {
    const current = resource;
    resource = undefined;
    await current?.dispose();
  };

  pi.on("session_start", async (_event, ctx) => {
    clearSubagentRegistry();
    await stopFff();
    try {
      resource = await FffSidecar.start(ctx.cwd);
    } catch {
      resource = undefined;
    }
  });

  pi.on("session_shutdown", async () => {
    clearSubagentRegistry();
    await stopFff();
  });

  return {
    fff: {
      current: (cwd) => resource && (cwd === undefined || resource.basePath === cwd) ? resource.client : undefined,
      endpoint: (cwd) => resource && (cwd === undefined || resource.basePath === cwd) ? resource.socketPath : undefined,
    },
  };
}
