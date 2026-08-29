import { resolve } from "node:path";
import type { FileItem, GrepOptions, GrepResult, MixedSearchResult, MultiGrepOptions, SearchOptions, SearchResult, WatchEvent } from "@ff-labs/fff-node";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";
import type { FffClient } from "../lifecycle/fff-client.ts";

export interface WorkspaceSearchStatus { readonly version: string; readonly state: "indexing" | "ready" | "error" | "stopped"; readonly indexedFiles: number; readonly watcherReady: boolean; readonly contentIndex: boolean; readonly sharedSidecar: boolean; readonly error?: string; }
export type WorkspaceChangeListener = (events: readonly WatchEvent[]) => void;

export class WorkspaceSearch {
  readonly root: string;
  readonly access: FilesystemAccess;
  private readonly client: FffClient;
  private readonly listeners = new Set<WorkspaceChangeListener>();
  private unsubscribe: (() => Promise<void>) | undefined;
  private focusFile: string | undefined;
  private readonly pendingQueries = new Map<string, Set<string>>();

  constructor(cwd: string, access: FilesystemAccess, client: FffClient) { this.root = resolve(cwd); this.access = access; this.client = client; }

  async fileSearch(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const result = await this.client.request("fileSearch", { query, options: this.withFocus(options) }) as SearchResult;
    this.pendingQueries.set(query, new Set(result.items.map(({ relativePath }) => resolve(this.root, relativePath))));
    return result;
  }
  glob(pattern: string, options: SearchOptions = {}): Promise<SearchResult> { return this.client.request("glob", { pattern, options: this.withFocus(options) }) as Promise<SearchResult>; }
  mixedSearch(query: string, options: SearchOptions = {}): Promise<MixedSearchResult> { return this.client.request("mixedSearch", { query, options: this.withFocus(options) }) as Promise<MixedSearchResult>; }
  grep(query: string, options: GrepOptions): Promise<GrepResult> { return this.client.request("grep", { query, options }) as Promise<GrepResult>; }
  multiGrep(options: MultiGrepOptions): Promise<GrepResult> { return this.client.request("multiGrep", options) as Promise<GrepResult>; }
  async files(): Promise<FileItem[]> { return this.filterInventory(await this.client.request("files") as FileItem[]); }
  async dirtyFiles(): Promise<FileItem[]> { return this.filterInventory(await this.client.request("dirtyFiles") as FileItem[]); }

  onChange(listener: WorkspaceChangeListener): () => void {
    this.listeners.add(listener);
    if (!this.unsubscribe) void this.client.subscribe((events) => { for (const current of this.listeners) current(events); }).then((unsubscribe) => { this.unsubscribe = unsubscribe; }).catch(() => undefined);
    return () => { this.listeners.delete(listener); if (this.listeners.size === 0 && this.unsubscribe) { const unsubscribe = this.unsubscribe; this.unsubscribe = undefined; void unsubscribe().catch(() => undefined); } };
  }
  recordFocus(path: string): void { const absolute = resolve(this.root, path); this.focusFile = absolute; for (const [query, candidates] of this.pendingQueries) { if (!candidates.has(absolute)) continue; void this.trackQuery(query, absolute); this.pendingQueries.delete(query); } }
  async trackQuery(query: string, selectedFilePath: string): Promise<void> { await this.client.request("trackQuery", { query, selectedFilePath: resolve(this.root, selectedFilePath) }); }
  async status(): Promise<WorkspaceSearchStatus> {
    try { const value = await this.client.request("status") as { progress: { scannedFilesCount: number; isScanning: boolean; isWatcherReady: boolean; isWarmupComplete: boolean }; health: { version?: string } }; return { version: value.health.version ?? "0.10.3", state: value.progress.isScanning || !value.progress.isWarmupComplete ? "indexing" : "ready", indexedFiles: value.progress.scannedFilesCount, watcherReady: value.progress.isWatcherReady, contentIndex: true, sharedSidecar: true }; }
    catch (error) { return { version: "0.10.3", state: "error", indexedFiles: 0, watcherReady: false, contentIndex: true, sharedSidecar: true, error: error instanceof Error ? error.message : String(error) }; }
  }
  private async filterInventory(items: FileItem[]): Promise<FileItem[]> { const allowed = new Set(await this.access.filter(items.map(({ relativePath }) => resolve(this.root, relativePath)))); return items.filter(({ relativePath }) => allowed.has(resolve(this.root, relativePath))); }
  private withFocus(options: SearchOptions): SearchOptions { return this.focusFile ? { ...options, currentFile: this.focusFile } : options; }
}
