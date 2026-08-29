import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccessPolicy } from "../../config/index.ts";
import { loadExtensionConfig } from "../../config/index.ts";
import { resolveRuntimeTempDir, type TempDirSource } from "../sandbox/config.ts";
import {
  evaluateFilesystem,
  followFallbackAccess,
  mostRestrictiveFilesystemDecision,
  type FilesystemDecision,
  type FilesystemOperation,
} from "../policy/filesystem.ts";
import {
  canonicalizeWorkspace,
  normalizeToolPath,
  resolveAccessTarget,
  selectReadPath,
  type CanonicalWorkspace,
} from "./paths.ts";

export interface FilesystemAuthorization {
  readonly path: string;
  readonly canonicalPath: string;
  readonly withinWorkspace: boolean;
  readonly decision: FilesystemDecision;
}

export interface FilesystemAccessOptions {
  readonly tempSource?: TempDirSource;
  readonly loadConfig?: () => Promise<AccessPolicy>;
}

export class FilesystemAccess {
  readonly cwd: string;
  private readonly options: FilesystemAccessOptions;
  private readonly workspace: Promise<CanonicalWorkspace>;
  private readonly config: Promise<AccessPolicy>;
  private tempPrefixes: Promise<readonly string[]> | undefined;

  constructor(cwd: string, options: FilesystemAccessOptions = {}) {
    this.cwd = cwd;
    this.options = options;
    this.workspace = canonicalizeWorkspace(cwd);
    this.config = (options.loadConfig ?? loadExtensionConfig)();
  }

  async authorize(path: string, operation: FilesystemOperation): Promise<FilesystemAuthorization> {
    const [config, workspace] = await Promise.all([this.config, this.workspace]);
    const normalized = normalizeToolPath(path, workspace.cwd);
    const selected = operation === "read" ? await selectReadPath(normalized) : normalized;
    const target = await resolveAccessTarget(selected, workspace);
    const decision = mostRestrictiveFilesystemDecision([
      evaluateFilesystem(config, workspace.cwd, target.path, operation),
      evaluateFilesystem(
        config,
        workspace.canonicalRoot,
        target.canonicalPath,
        operation,
        followFallbackAccess(config, workspace.cwd, target.path),
      ),
    ]);

    return { ...target, decision };
  }

  async filter(paths: readonly string[], operation: FilesystemOperation = "read"): Promise<string[]> {
    const decisions = await Promise.all(paths.map(async (path) => {
      try {
        return { path, allowed: (await this.authorize(path, operation)).decision === "allow" };
      } catch {
        return { path, allowed: false };
      }
    }));
    return decisions.filter(({ allowed }) => allowed).map(({ path }) => path);
  }

  async permits(path: string, operation: FilesystemOperation = "read"): Promise<boolean> {
    return (await this.authorize(path, operation)).decision === "allow";
  }

  async request(
    path: string,
    operation: FilesystemOperation,
    label: string,
    ctx: ExtensionContext,
    pi: ExtensionAPI,
  ): Promise<FilesystemAuthorization> {
    const authorization = await this.authorize(path, operation);
    if (authorization.decision !== "ask") return authorization;
    if (await this.withinRuntimeTemp(authorization)) return { ...authorization, decision: "allow" };
    if (!ctx.hasUI) return authorization;

    const allowed = await ctx.ui.confirm(
      "Outside workspace access",
      `Allow ${label} on ${authorization.path}?`,
    );
    pi.sendMessage({
      customType: "filesystem",
      content: `User ${allowed ? "approved" : "denied"} outside-workspace access: ${label} ${authorization.path}`,
      display: false,
    });
    return allowed ? { ...authorization, decision: "allow" } : authorization;
  }

  private async withinRuntimeTemp(target: FilesystemAuthorization): Promise<boolean> {
    if (this.tempPrefixes === undefined) {
      const resolved = this.options.tempSource !== undefined ? { source: this.options.tempSource } : {};
      this.tempPrefixes = resolveRuntimeTempDir(resolved).then((temp) => temp.path === undefined ? [] : [temp.path]);
    }
    const prefixes = await this.tempPrefixes;
    return prefixes.some((prefix) =>
      target.path === prefix || target.path.startsWith(`${prefix}/`) ||
      target.canonicalPath === prefix || target.canonicalPath.startsWith(`${prefix}/`));
  }
}
