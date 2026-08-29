import type {
  GrepOptions, MultiGrepOptions, SearchOptions, WatchEvent, WatchOptions,
} from "@ff-labs/fff-node";

export const FFF_SOCKET_ENV = "PI_GEAR_FFF_SOCKET";
export const DEFAULT_INDEX_READY_TIMEOUT_MS = 10_000;

export type FffMethod =
  | "status" | "fileSearch" | "glob" | "mixedSearch" | "grep" | "multiGrep"
  | "files" | "dirtyFiles" | "trackQuery" | "subscribe" | "unsubscribe" | "shutdown";

export interface FffRequest {
  id: number;
  method: FffMethod;
  params?: unknown;
}

export type FffResponse =
  | { id: number; result: unknown }
  | { id: number; error: string };

export interface FffEvent {
  event: "watch";
  subscriptionId: number;
  data: WatchEvent[];
}

export type FffMessage = FffResponse | FffEvent;

export interface FffParams {
  status: undefined;
  fileSearch: { query: string; options?: SearchOptions };
  glob: { pattern: string; options?: SearchOptions };
  mixedSearch: { query: string; options?: SearchOptions };
  grep: { query: string; options?: GrepOptions };
  multiGrep: MultiGrepOptions;
  files: { pageSize?: number } | undefined;
  dirtyFiles: { pageSize?: number } | undefined;
  trackQuery: { query: string; selectedFilePath: string };
  subscribe: { pattern?: string; options?: WatchOptions };
  unsubscribe: { subscriptionId: number };
  shutdown: undefined;
}
