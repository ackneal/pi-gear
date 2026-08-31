import { resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FilesystemAccessService } from "../execution/filesystem/guard.ts";
import type { FffClient } from "../lifecycle/fff-client.ts";
import { FffClient as SocketFffClient } from "../lifecycle/fff-client.ts";
import { FFF_SOCKET_ENV } from "../lifecycle/fff-protocol.ts";
import { WorkspaceAutocompleteProvider } from "./autocomplete.ts";
import {
  WorkspaceSearch,
  type WorkspaceSearchClient,
  type WorkspaceSearchStatus,
} from "./service.ts";
import { registerWorkspaceTools } from "./tools.ts";

export interface FffClientSource {
  current(cwd?: string): FffClient | undefined;
  endpoint(cwd?: string): string | undefined;
  failure?(cwd?: string): string | undefined;
}

export interface WorkspaceServices {
  current(cwd?: string): WorkspaceSearch | undefined;
  status(cwd: string): Promise<WorkspaceSearchStatus | undefined>;
  endpoint(cwd?: string): string | undefined;
}

export function setupWorkspace(
  pi: ExtensionAPI,
  filesystem: FilesystemAccessService,
  source?: FffClientSource,
): WorkspaceServices {
  let search: WorkspaceSearch | undefined;
  let ownedClient: FffClient | undefined;
  let connectionError: string | undefined;

  const clear = (): void => {
    search = undefined;
    ownedClient?.close();
    ownedClient = undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    clear();
    connectionError = source?.failure?.(ctx.cwd);

    let client: WorkspaceSearchClient | undefined = source?.current(ctx.cwd);
    const endpoint = source?.endpoint(ctx.cwd) ?? process.env[FFF_SOCKET_ENV];
    if (!client && endpoint) {
      try {
        ownedClient = await SocketFffClient.connect(endpoint);
        client = ownedClient;
      } catch (error) {
        connectionError = error instanceof Error ? error.message : String(error);
      }
    }

    if (!client) {
      connectionError ??= "FFF sidecar unavailable";
      pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "find" && name !== "grep"));
      return;
    }

    const access = filesystem.forWorkspace(ctx.cwd);
    const sessionSearch = new WorkspaceSearch(ctx.cwd, access, client);
    search = sessionSearch;
    registerWorkspaceTools(pi, sessionSearch, access);
    if (ctx.hasUI) {
      ctx.ui.addAutocompleteProvider((fallback) =>
        new WorkspaceAutocompleteProvider(fallback, sessionSearch),
      );
    }
  });

  pi.on("tool_result", (event) => {
    if (!search || event.isError || !["read", "edit", "write"].includes(event.toolName)) {
      return;
    }
    if (typeof event.input.path === "string") {
      search.recordFocus(event.input.path);
    }
  });

  pi.on("session_shutdown", clear);

  return {
    current: (cwd) => {
      const matches = cwd === undefined || search?.root === resolve(cwd);
      return search && matches ? search : undefined;
    },
    status: async (cwd) => {
      if (search && search.root === resolve(cwd)) return search.status();
      if (connectionError) {
        return {
          version: "0.10.3",
          state: "error",
          indexedFiles: 0,
          watcherReady: false,
          contentIndex: true,
          sharedSidecar: false,
          error: connectionError,
        };
      }
      return undefined;
    },
    endpoint: (cwd) => source?.endpoint(cwd) ?? process.env[FFF_SOCKET_ENV],
  };
}
