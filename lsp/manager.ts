import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import { constants, watch, type FSWatcher } from "node:fs";
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { AccessPolicy, LspServerConfig } from "../config/types.ts";
import { canonicalizeWorkspace, normalizeToolPath, resolveAccessTarget, type CanonicalWorkspace } from "../execution/filesystem/paths.ts";
import { evaluateFilesystem, followFallbackAccess, mostRestrictiveFilesystemDecision } from "../execution/policy/filesystem.ts";
import { LspClient } from "./client.ts";
import { diagnosticKey, normalizeDiagnostics } from "./normalize.ts";
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

const MAX_DIAGNOSTIC_FILES = 100;
const MAX_WORKSPACE_ENTRIES = 5_000;

const gitStatus = (cwd: string): Promise<string[] | undefined> => new Promise((resolveResult) => {
  execFile("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "utf8" }, (error, stdout) => {
    if (error) return resolveResult(undefined);
    const records = stdout.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let i = 0; i < records.length; i++) {
      const record = records[i] ?? "";
      paths.push(record.slice(3));
      if (/^[RC]|^[ MARC][RC]/.test(record.slice(0, 2))) i++;
    }
    resolveResult(paths);
  });
});

const workspaceFiles = async (cwd: string, extensions: ReadonlySet<string>): Promise<string[]> => {
  const files: string[] = [];
  let entries = 0;

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries++;
      if (entries > MAX_WORKSPACE_ENTRIES) {
        throw new Error(`Workspace diagnostics exceeded the ${MAX_WORKSPACE_ENTRIES}-entry scan limit; use scope "changed"`);
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await visit(join(directory, entry.name));
      } else if (entry.isFile() && extensions.has(extname(entry.name))) {
        files.push(join(directory, entry.name));
        if (files.length > MAX_DIAGNOSTIC_FILES) {
          throw new Error(`Diagnostics exceeded the ${MAX_DIAGNOSTIC_FILES}-file limit; use scope "changed"`);
        }
      }
    }
  };

  await visit(cwd);
  return files;
};

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
  private readonly surfacedErrors = new Map<string, Set<string>>();
  private workspace: CanonicalWorkspace | undefined;
  private watcher: FSWatcher | undefined;
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  readonly servers: readonly LspServerConfig[];
  readonly cwd: string;
  private readonly createClient: LspClientFactory;
  private readonly policy: AccessPolicy;
  private readonly idleTimeoutMs: number;

  constructor(
    servers: readonly LspServerConfig[],
    cwd: string,
    createClient: LspClientFactory = (config, root) => new LspClient(config, root),
    policy: AccessPolicy = { filesystem: { rules: [] }, network: { rules: [] } },
    idleTimeoutMinutes = 15,
  ) {
    this.servers = servers;
    this.cwd = cwd;
    this.createClient = createClient;
    this.policy = policy;
    this.idleTimeoutMs = idleTimeoutMinutes * 60_000;
    for (const server of servers) {
      for (const extension of server.extensions) this.byExtension.set(extension, server);
    }
  }

  async initializeWorkspace(): Promise<void> {
    this.workspace = await canonicalizeWorkspace(this.cwd);
  }

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
    const workspace = this.workspace ?? await canonicalizeWorkspace(this.cwd);
    this.workspace = workspace;
    const target = await resolveAccessTarget(normalizeToolPath(path, workspace.cwd), workspace);
    if (!target.withinWorkspace) throw new Error(`Path is outside workspace: ${path}`);
    const decision = mostRestrictiveFilesystemDecision([
      evaluateFilesystem(this.policy, workspace.cwd, target.path, "read"),
      evaluateFilesystem(
        this.policy,
        workspace.canonicalRoot,
        target.canonicalPath,
        "read",
        followFallbackAccess(this.policy, workspace.cwd, target.path),
      ),
    ]);
    if (decision !== "allow") throw new Error(`LSP read access is not permitted: ${path}`);
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

  async primeErrors(path: string): Promise<void> {
    const diagnostics = await this.sync(path);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    this.surfacedErrors.set(resolve(this.cwd, path), new Set(errors.map(diagnosticKey)));
  }

  async newErrors(path: string): Promise<NormalizedDiagnostic[]> {
    const diagnostics = await this.sync(path);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    const previous = this.surfacedErrors.get(resolve(this.cwd, path)) ?? new Set<string>();
    const current = new Set(errors.map(diagnosticKey));
    this.surfacedErrors.set(resolve(this.cwd, path), current);
    return errors.filter((diagnostic) => !previous.has(diagnosticKey(diagnostic)));
  }

  async diagnostics(scope: "changed" | "workspace"): Promise<NormalizedDiagnostic[]> {
    const extensions = new Set(this.byExtension.keys());
    let paths: string[];
    if (scope === "workspace") {
      paths = await workspaceFiles(this.cwd, extensions);
    } else {
      const changed = await gitStatus(this.cwd);
      paths = changed?.map((path) => resolve(this.cwd, path)).filter((path) => extensions.has(extname(path))) ?? [];
    }
    if (paths.length > MAX_DIAGNOSTIC_FILES) {
      throw new Error(`Diagnostics exceeded the ${MAX_DIAGNOSTIC_FILES}-file limit; narrow the changed set`);
    }

    const results = await Promise.all(paths.map(async (path) => {
      try {
        return await this.sync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
    }));
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

  startWatching(): void {
    if (this.watcher || this.closing || this.servers.length === 0) return;
    this.watcher = watch(this.cwd, { recursive: true }, (_event, filename) => {
      if (!filename || !this.match(filename)) return;
      const path = resolve(this.cwd, filename);
      const previous = this.debounce.get(path);
      if (previous) clearTimeout(previous);
      this.debounce.set(path, setTimeout(() => {
        this.debounce.delete(path);
        if (!this.closing) void this.sync(path).catch(() => {});
      }, 100));
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
    this.watcher?.close();
    this.watcher = undefined;
    for (const timeout of this.debounce.values()) clearTimeout(timeout);
    this.debounce.clear();
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
