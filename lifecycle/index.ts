import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearSubagentRegistry } from "../ui/subagent/detail/registry.ts";
import { setupLoopGuard } from "./loop.ts";
import { FffSidecar } from "./fff.ts";
import type { FffClient } from "./fff-client.ts";

export interface LifecycleServices {
  readonly fff: {
    current(cwd?: string): FffClient | undefined;
    endpoint(cwd?: string): string | undefined;
    failure(cwd?: string): string | undefined;
  };
}

export interface LifecycleOptions {
  startFff?: (cwd: string) => Promise<FffSidecar>;
}

export function setupLifecycle(pi: ExtensionAPI, options: LifecycleOptions = {}): LifecycleServices {
  setupLoopGuard(pi);
  let resource: FffSidecar | undefined;
  let startupFailure: { cwd: string; reason: string } | undefined;

  const stopFff = async (): Promise<void> => {
    const current = resource;
    resource = undefined;
    await current?.dispose();
  };

  pi.on("session_start", async (_event, ctx) => {
    clearSubagentRegistry();
    await stopFff();
    startupFailure = undefined;
    try {
      resource = await (options.startFff ?? FffSidecar.start)(ctx.cwd);
    } catch (error) {
      resource = undefined;
      const reason = error instanceof Error ? error.message : String(error);
      if (ctx?.cwd) startupFailure = { cwd: ctx.cwd, reason: `FFF sidecar unavailable: ${reason}` };
    }
  });

  pi.on("session_shutdown", async () => {
    clearSubagentRegistry();
    startupFailure = undefined;
    await stopFff();
  });

  return {
    fff: {
      current: (cwd) => resource && (cwd === undefined || resource.basePath === cwd) ? resource.client : undefined,
      endpoint: (cwd) => resource && (cwd === undefined || resource.basePath === cwd) ? resource.socketPath : undefined,
      failure: (cwd) => startupFailure && (cwd === undefined || startupFailure.cwd === cwd) ? startupFailure.reason : undefined,
    },
  };
}
