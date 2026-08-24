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
import type { LspDiagnostic, NormalizedDiagnostic, SourceLocation } from "./types.ts";

export interface LspServerStatus {
  readonly extensions: readonly string[];
  readonly executable: string;
  readonly available: boolean;
  readonly reason?: string;
}

export type LspClientFactory = (config: LspServerConfig, cwd: string) => LspClient;

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

  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules") continue;
        await visit(join(directory, entry.name));
      } else if (entry.isFile() && extensions.has(extname(entry.name))) {
        files.push(join(directory, entry.name));
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
  private readonly clients = new Map<LspServerConfig, LspClient>();
  private readonly surfacedErrors = new Map<string, Set<string>>();
  private workspace: CanonicalWorkspace | undefined;
  private watcher: FSWatcher | undefined;
  private debounce = new Map<string, ReturnType<typeof setTimeout>>();
  private closing = false;
  readonly servers: readonly LspServerConfig[];
  readonly cwd: string;
  private readonly createClient: LspClientFactory;
  private readonly policy: AccessPolicy;

  constructor(
    servers: readonly LspServerConfig[],
    cwd: string,
    createClient: LspClientFactory = (config, root) => new LspClient(config, root),
    policy: AccessPolicy = { filesystem: { rules: [] }, network: { rules: [] } },
  ) {
    this.servers = servers;
    this.cwd = cwd;
    this.createClient = createClient;
    this.policy = policy;
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

  private client(config: LspServerConfig): LspClient {
    let client = this.clients.get(config);
    if (!client) {
      client = this.createClient(config, this.cwd);
      this.clients.set(config, client);
    }
    return client;
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
    const client = this.client(config);
    const revision = client.diagnosticsRevision(absolute);
    await client.sync(absolute);
    await client.waitForDiagnostics(absolute, revision);
    return normalizeDiagnostics(absolute, this.cwd, client.diagnosticsFor(absolute));
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
    const changed = scope === "changed" ? await gitStatus(this.cwd) : undefined;
    const paths = changed === undefined
      ? await workspaceFiles(this.cwd, extensions)
      : changed.map((path) => resolve(this.cwd, path)).filter((path) => extensions.has(extname(path)));
    const diagnostics: NormalizedDiagnostic[] = [];

    for (const path of paths) {
      try {
        diagnostics.push(...await this.sync(path));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return diagnostics.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  }

  async navigate(action: "definition" | "references", path: string, line: number, column: number): Promise<SourceLocation[]> {
    const absolute = await this.sourcePath(path);
    const config = this.match(absolute);
    if (!config) throw new Error(`No language server configured for ${extname(absolute) || "this file"}`);
    const response = await this.client(config).navigate(
      action === "definition" ? "textDocument/definition" : "textDocument/references",
      absolute,
      { line: line - 1, character: column - 1 },
    );
    const values = response === null || response === undefined ? [] : Array.isArray(response) ? response : [response];
    const locations: SourceLocation[] = [];

    for (const value of values as Array<Record<string, unknown>>) {
      const uri = typeof value.uri === "string" ? value.uri : typeof value.targetUri === "string" ? value.targetUri : undefined;
      const range = (value.range ?? value.targetSelectionRange) as { start?: { line?: unknown; character?: unknown } } | undefined;
      if (!uri?.startsWith("file:") || typeof range?.start?.line !== "number" || typeof range.start.character !== "number") continue;
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
        ...(!executable ? { reason: "misconfigured" } : available ? {} : { reason: "not found" }),
      };
    }));
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    this.watcher?.close();
    this.watcher = undefined;
    for (const timeout of this.debounce.values()) clearTimeout(timeout);
    this.debounce.clear();
    await Promise.all([...this.clients.values()].map((client) => client.shutdown()));
    this.clients.clear();
  }
}
