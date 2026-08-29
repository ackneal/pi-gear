import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccessPolicy, LspServerConfig } from "../config/types.ts";
import { FilesystemAccess } from "../execution/filesystem/access.ts";
import type { WorkspaceSearch } from "../workspace/service.ts";
import { LspClient } from "./client.ts";
import { deduplicateAndOrderDiagnostics, diagnosticKey, normalizeDiagnostics } from "./normalize.ts";
import { parseNavigationResponse } from "./schema.ts";
import type { NormalizedDiagnostic, SourceLocation } from "./types.ts";

export interface LspServerStatus {
  readonly extensions: readonly string[];
  readonly executable: string;
  readonly available: boolean;
  readonly running: boolean;
}

export type LspClientFactory = (config: LspServerConfig, cwd: string) => LspClient;

interface ActiveClient {
  readonly client: LspClient;
  activeOperations: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const MAX_CHANGED_DIAGNOSTIC_FILES = 100;
const MAX_WORKSPACE_CONCURRENCY = 8;

const executableAvailable = async (executable: string, cwd: string, envPath = process.env.PATH ?? ""): Promise<boolean> => {
  const candidates = executable.includes(sep) || isAbsolute(executable)
    ? [resolve(cwd, executable)]
    : envPath.split(delimiter).filter(Boolean).map((directory) => join(directory, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {}
  }
  return false;
};

export class LspManager {
  private readonly byExtension = new Map<string, LspServerConfig>();
  private readonly clients = new Map<LspServerConfig, ActiveClient>();
  private readonly retiring = new Map<LspServerConfig, Promise<void>>();
  private unsubscribeWorkspace: (() => void) | undefined;
  private readonly watcherOperations = new Set<Promise<void>>();
  private readonly diagnosticsBeforeEdit = new Map<string, Set<string>>();
  private closing = false;
  readonly servers: readonly LspServerConfig[];
  readonly cwd: string;
  private readonly createClient: LspClientFactory;
  private readonly idleTimeoutMs: number;
  private readonly filesystem: FilesystemAccess;
  private readonly workspaceSearch: WorkspaceSearch | undefined;

  constructor(
    servers: readonly LspServerConfig[],
    cwd: string,
    createClient: LspClientFactory = (config, root) => new LspClient(config, root),
    policy: AccessPolicy = { filesystem: { rules: [] }, sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } } },
    idleTimeoutMinutes = 15,
    filesystem?: FilesystemAccess,
    workspaceSearch?: WorkspaceSearch,
  ) {
    this.servers = servers;
    this.cwd = cwd;
    this.createClient = createClient;
    this.idleTimeoutMs = idleTimeoutMinutes * 60_000;
    this.filesystem = filesystem ?? new FilesystemAccess(cwd, { loadConfig: async () => policy });
    this.workspaceSearch = workspaceSearch;
    for (const server of servers) {
      for (const extension of server.extensions) this.byExtension.set(extension, server);
    }
  }

  async initializeWorkspace(): Promise<void> {}

  match(path: string): LspServerConfig | undefined {
    return this.byExtension.get(extname(path));
  }

  private async withClient<T>(config: LspServerConfig, operation: (client: LspClient) => Promise<T>): Promise<T> {
    let entry = this.clients.get(config);
    if (!entry) {
      await this.retiring.get(config);
      entry = this.clients.get(config);
    }
    if (!entry) {
      entry = { client: this.createClient(config, this.cwd), activeOperations: 0 };
      this.clients.set(config, entry);
    }
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    delete entry.idleTimer;
    entry.activeOperations++;

    try {
      return await operation(entry.client);
    } finally {
      entry.activeOperations--;
      if (!this.closing && entry.activeOperations === 0 && this.idleTimeoutMs > 0) {
        const activeEntry = entry;
        entry.idleTimer = setTimeout(() => {
          if (this.clients.get(config) !== activeEntry || activeEntry.activeOperations !== 0) return;
          this.clients.delete(config);
          const retirement = activeEntry.client.shutdown()
            .catch(() => {})
            .finally(() => {
              if (this.retiring.get(config) === retirement) this.retiring.delete(config);
            });
          this.retiring.set(config, retirement);
        }, this.idleTimeoutMs);
      }
    }
  }

  private async sourcePath(path: string): Promise<string> {
    if (this.closing) throw new Error("LSP manager is shutting down");
    const target = await this.filesystem.authorize(path, "read");
    if (!target.withinWorkspace) throw new Error(`Path is outside workspace: ${path}`);
    if (target.decision !== "allow") throw new Error(`LSP read access is not permitted: ${path}`);
    return target.path;
  }

  async sync(path: string): Promise<NormalizedDiagnostic[]> {
    const absolute = await this.sourcePath(path);
    const config = this.match(absolute);
    if (!config) throw new Error(`No language server configured for ${extname(absolute) || "this file"}`);
    return this.withClient(config, async (client) => {
      const revision = client.diagnosticsRevision(absolute);
      await client.sync(absolute);
      await client.waitForDiagnostics(absolute, revision);
      return normalizeDiagnostics(absolute, this.cwd, client.diagnosticsFor(absolute));
    });
  }

  async primeDiagnostics(path: string): Promise<void> {
    const diagnostics = await this.sync(path);
    this.diagnosticsBeforeEdit.set(resolve(this.cwd, path), new Set(diagnostics.map(diagnosticKey)));
  }

  clearDiagnosticsBaseline(path: string): void {
    this.diagnosticsBeforeEdit.delete(resolve(this.cwd, path));
  }

  async changedDiagnostics(path: string): Promise<NormalizedDiagnostic[]> {
    const absolute = resolve(this.cwd, path);
    const previous = this.diagnosticsBeforeEdit.get(absolute);
    if (!previous) return [];
    this.diagnosticsBeforeEdit.delete(absolute);

    const diagnostics = await this.sync(path);
    return deduplicateAndOrderDiagnostics(
      diagnostics.filter((diagnostic) => !previous.has(diagnosticKey(diagnostic))),
    );
  }

  private async syncDiagnosticPath(path: string): Promise<NormalizedDiagnostic[]> {
    try {
      return await this.sync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  private async syncWorkspaceDiagnostics(paths: readonly string[]): Promise<NormalizedDiagnostic[][]> {
    const results = new Array<NormalizedDiagnostic[]>(paths.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < paths.length) {
        const index = next++;
        results[index] = await this.syncDiagnosticPath(paths[index]!);
      }
    };

    await Promise.all(Array.from(
      { length: Math.min(MAX_WORKSPACE_CONCURRENCY, paths.length) },
      worker,
    ));
    return results;
  }

  async diagnostics(scope: "changed" | "workspace"): Promise<NormalizedDiagnostic[]> {
    if (!this.workspaceSearch) throw new Error("Workspace search is unavailable");
    const extensions = new Set(this.byExtension.keys());
    let results: NormalizedDiagnostic[][];
    if (scope === "workspace") {
      const paths = (await this.workspaceSearch.files())
        .map(({ relativePath }) => resolve(this.cwd, relativePath))
        .filter((path) => extensions.has(extname(path)));
      results = await this.syncWorkspaceDiagnostics(paths);
    } else {
      const paths = (await this.workspaceSearch.dirtyFiles())
        .map(({ relativePath }) => resolve(this.cwd, relativePath))
        .filter((path) => extensions.has(extname(path)));
      if (paths.length > MAX_CHANGED_DIAGNOSTIC_FILES) {
        throw new Error(`Diagnostics exceeded the ${MAX_CHANGED_DIAGNOSTIC_FILES}-file limit; narrow the changed set`);
      }
      results = await Promise.all(paths.map((path) => this.syncDiagnosticPath(path)));
    }

    return results.flat().sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  }

  async navigate(
    action: "definition" | "references",
    path: string,
    line: number,
    column: number,
    signal?: AbortSignal,
  ): Promise<SourceLocation[]> {
    const absolute = await this.sourcePath(path);
    const config = this.match(absolute);
    if (!config) throw new Error(`No language server configured for ${extname(absolute) || "this file"}`);
    const response = await this.withClient(config, (client) => client.navigate(
      action === "definition" ? "textDocument/definition" : "textDocument/references",
      absolute,
      { line: line - 1, character: column - 1 },
      signal,
    ));
    const values = parseNavigationResponse(action, response);
    const locations: SourceLocation[] = [];

    for (const value of values) {
      const uri = "uri" in value ? value.uri : value.targetUri;
      const range = "range" in value ? value.range : value.targetSelectionRange;
      if (!uri.startsWith("file:")) continue;
      let target: string;
      try {
        target = await this.sourcePath(fileURLToPath(uri));
      } catch {
        continue;
      }
      const relativePath = relative(this.cwd, target);
      locations.push({ path: relativePath || ".", line: range.start.line + 1, column: range.start.character + 1 });
    }
    return locations;
  }

  private scheduleWatcherSync(filename: string): void {
    if (!this.match(filename) || this.closing) return;
    const operation = this.syncWatcherPath(resolve(this.cwd, filename)).catch(() => {});
    this.watcherOperations.add(operation);
    void operation.finally(() => this.watcherOperations.delete(operation));
  }

  private async syncWatcherPath(path: string): Promise<void> {
    if (this.closing) return;
    await this.sync(path);
  }

  startWatching(): void {
    if (this.unsubscribeWorkspace || this.closing || this.servers.length === 0 || !this.workspaceSearch) return;
    this.unsubscribeWorkspace = this.workspaceSearch.onChange((events) => {
      for (const event of events) {
        if (event.kind === "removed") continue;
        if (event.kind === "rescan") {
          continue;
          continue;
        }
        this.scheduleWatcherSync(event.path);
      }
    });
  }

  async statuses(): Promise<LspServerStatus[]> {
    return Promise.all(this.servers.map(async (server) => {
      const executable = server.command[0];
      const available = executable ? await executableAvailable(executable, this.cwd) : false;
      return {
        extensions: server.extensions,
        executable: executable ?? "(missing)",
        available,
        running: this.clients.get(server)?.client.running ?? false,
      };
    }));
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.unsubscribeWorkspace?.();
    this.unsubscribeWorkspace = undefined;
    await Promise.all(this.watcherOperations);
    for (const entry of this.clients.values()) {
      if (entry.idleTimer) clearTimeout(entry.idleTimer);
    }
    await Promise.all([
      ...[...this.clients.values()].map(({ client }) => client.shutdown()),
      ...this.retiring.values(),
    ]);
    this.clients.clear();
    this.retiring.clear();
  }
}
