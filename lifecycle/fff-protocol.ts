import type {
  FileFinderApi, GrepOptions, MultiGrepOptions, SearchOptions, WatchEvent, WatchOptions,
} from "@ff-labs/fff-bun";

// GlobOptions exists in the SDK API but is not re-exported by @ff-labs/fff-bun.
export type GlobOptions = NonNullable<Parameters<FileFinderApi["glob"]>[1]>;

export const FFF_SOCKET_ENV = "PI_GEAR_FFF_SOCKET";
export const DEFAULT_INDEX_READY_TIMEOUT_MS = 10_000;

export interface FffParams {
  status: undefined;
  fileSearch: { query: string; options?: SearchOptions };
  glob: { pattern: string; options?: GlobOptions };
  mixedSearch: { query: string; options?: SearchOptions };
  grep: { query: string; options?: GrepOptions };
  multiGrep: MultiGrepOptions;
  files: { pageSize?: number } | undefined;
  dirtyFiles: { pageSize?: number } | undefined;
  trackQuery: { query: string; selectedFilePath: string };
  subscribe: { pattern?: string; options?: WatchOptions } | undefined;
  unsubscribe: { subscriptionId: number };
  shutdown: undefined;
}

export type FffMethod = keyof FffParams;
type FffRequestFor<M extends FffMethod> = undefined extends FffParams[M]
  ? { id: number; method: M; params?: FffParams[M] }
  : { id: number; method: M; params: FffParams[M] };
export type FffRequest = { [M in FffMethod]: FffRequestFor<M> }[FffMethod];

export type FffResponse =
  | { id: number; result: unknown }
  | { id: number; error: string };

export interface FffEvent {
  event: "watch";
  subscriptionId: number;
  data: WatchEvent[];
}

export type FffMessage = FffResponse | FffEvent;

const watchKinds = new Set(["created", "modified", "removed", "rescan"]);
const grepModes = new Set(["plain", "regex", "fuzzy"]);
const globOptionKeys = new Set(["maxThreads", "currentFile", "pageIndex", "pageSize"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";
const isString = (value: unknown): value is string => typeof value === "string";
const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every(isString);
const optional = (
  value: Record<string, unknown>,
  key: string,
  validate: (field: unknown) => boolean,
): boolean => !hasOwn(value, key) || validate(value[key]);

function isSearchOptions(value: unknown): value is SearchOptions {
  return isRecord(value)
    && optional(value, "maxThreads", isId)
    && optional(value, "currentFile", isString)
    && optional(value, "comboBoostMultiplier", isNumber)
    && optional(value, "minComboCount", isId)
    && optional(value, "pageIndex", isId)
    && optional(value, "pageSize", isId);
}

function isGlobOptions(value: unknown): value is GlobOptions {
  return isRecord(value)
    && Object.keys(value).every((key) => globOptionKeys.has(key))
    && optional(value, "maxThreads", isId)
    && optional(value, "currentFile", isString)
    && optional(value, "pageIndex", isId)
    && optional(value, "pageSize", isId);
}

function isGrepCursor(value: unknown): boolean {
  return value === null || (isRecord(value) && value.__brand === "GrepCursor" && isId(value._offset));
}

function isGrepOptions(value: unknown): value is GrepOptions {
  return isRecord(value)
    && optional(value, "maxFileSize", isId)
    && optional(value, "maxMatchesPerFile", isId)
    && optional(value, "smartCase", isBoolean)
    && optional(value, "cursor", isGrepCursor)
    && optional(value, "mode", (field) => typeof field === "string" && grepModes.has(field))
    && optional(value, "timeBudgetMs", isId)
    && optional(value, "beforeContext", isId)
    && optional(value, "afterContext", isId)
    && optional(value, "pageSize", isId)
    && optional(value, "classifyDefinitions", isBoolean);
}

function isMultiGrepOptions(value: unknown): value is MultiGrepOptions {
  return isRecord(value)
    && isStringArray(value.patterns)
    && optional(value, "constraints", isString)
    && optional(value, "maxFileSize", isId)
    && optional(value, "maxMatchesPerFile", isId)
    && optional(value, "smartCase", isBoolean)
    && optional(value, "cursor", isGrepCursor)
    && optional(value, "timeBudgetMs", isId)
    && optional(value, "beforeContext", isId)
    && optional(value, "afterContext", isId)
    && optional(value, "pageSize", isId)
    && optional(value, "classifyDefinitions", isBoolean);
}

function isWatchOptions(value: unknown): value is WatchOptions {
  return isRecord(value) && optional(value, "ignore", isStringArray);
}

const requestParamsValidators = {
  status: (value: unknown) => value === undefined,
  fileSearch: (value: unknown) => isRecord(value)
    && isString(value.query)
    && optional(value, "options", isSearchOptions),
  glob: (value: unknown) => isRecord(value)
    && isString(value.pattern)
    && optional(value, "options", isGlobOptions),
  mixedSearch: (value: unknown) => isRecord(value)
    && isString(value.query)
    && optional(value, "options", isSearchOptions),
  grep: (value: unknown) => isRecord(value)
    && isString(value.query)
    && optional(value, "options", isGrepOptions),
  multiGrep: isMultiGrepOptions,
  files: (value: unknown) => value === undefined
    || (isRecord(value) && optional(value, "pageSize", isId)),
  dirtyFiles: (value: unknown) => value === undefined
    || (isRecord(value) && optional(value, "pageSize", isId)),
  trackQuery: (value: unknown) => isRecord(value)
    && isString(value.query)
    && isString(value.selectedFilePath),
  subscribe: (value: unknown) => value === undefined || (isRecord(value)
    && optional(value, "pattern", isString)
    && optional(value, "options", isWatchOptions)),
  unsubscribe: (value: unknown) => isRecord(value) && isId(value.subscriptionId),
  shutdown: (value: unknown) => value === undefined,
} satisfies Record<FffMethod, (value: unknown) => boolean>;

const isFffMethod = (value: string): value is FffMethod => hasOwn(requestParamsValidators, value);

export function isFffRequest(value: unknown): value is FffRequest {
  if (!isRecord(value) || !isId(value.id) || typeof value.method !== "string") return false;
  if (!isFffMethod(value.method)) return false;

  return requestParamsValidators[value.method](value.params);
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
