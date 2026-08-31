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

const fffMethods = new Set<FffMethod>([
  "status", "fileSearch", "glob", "mixedSearch", "grep", "multiGrep",
  "files", "dirtyFiles", "trackQuery", "subscribe", "unsubscribe", "shutdown",
]);
const watchKinds = new Set(["created", "modified", "removed", "rescan"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

export function isFffRequest(value: unknown): value is FffRequest {
  return isRecord(value)
    && isId(value.id)
    && typeof value.method === "string"
    && fffMethods.has(value.method as FffMethod);
}

export function isFffMessage(value: unknown): value is FffMessage {
  if (!isRecord(value)) return false;

  if (value.event === "watch") {
    return isId(value.subscriptionId)
      && Array.isArray(value.data)
      && value.data.every((event) =>
        isRecord(event)
        && typeof event.path === "string"
        && typeof event.kind === "string"
        && watchKinds.has(event.kind));
  }

  if (!isId(value.id)) return false;
  const hasResult = hasOwn(value, "result");
  const hasError = hasOwn(value, "error");
  return hasResult !== hasError && (!hasError || typeof value.error === "string");
}

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
