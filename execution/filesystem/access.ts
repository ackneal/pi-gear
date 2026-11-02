import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendAllowedFilesystemRule,
  loadExtensionConfig,
  type AccessPolicy,
  type FilesystemAccess as FilesystemRuleAccess,
  type FilesystemRule,
} from "../../config/index.ts";
import { CONFIRMATION_TIMEOUT_MS, ConfirmationQueue } from "../confirmation-queue.ts";
import { resolveRuntimeTempDir, type TempDirSource } from "../sandbox/config.ts";
import {
  decisionForAccess,
  evaluateFilesystem,
  followFallbackAccess,
  matchesFilesystemSelector,
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
import { detectProjectRoot } from "./project.ts";

export interface FilesystemAuthorization {
  readonly path: string;
  readonly canonicalPath: string;
  readonly withinWorkspace: boolean;
  readonly decision: FilesystemDecision;
}

export interface SessionFilesystemApproval {
  readonly pattern: string;
  readonly access: FilesystemRuleAccess;
}

export interface FilesystemAccessOptions {
  readonly tempSource?: TempDirSource;
  readonly loadConfig?: () => Promise<AccessPolicy>;
  readonly confirmationQueue?: ConfirmationQueue;
  readonly persistRule?: (rule: FilesystemRule) => Promise<void>;
}

export class FilesystemAccess {
  readonly cwd: string;
  readonly sessionApprovals: SessionFilesystemApproval[] = [];
  private readonly options: FilesystemAccessOptions;
  private readonly workspace: Promise<CanonicalWorkspace>;
  private tempPrefixes: Promise<readonly string[]> | undefined;
  private readonly confirmationQueue: ConfirmationQueue;
  private readonly pendingPrompts = new Map<string, Promise<FilesystemAuthorization>>();

  constructor(cwd: string, options: FilesystemAccessOptions = {}) {
    this.cwd = cwd;
    this.options = options;
    this.workspace = canonicalizeWorkspace(cwd);
    this.confirmationQueue = options.confirmationQueue ?? new ConfirmationQueue();
  }

  async authorize(path: string, operation: FilesystemOperation): Promise<FilesystemAuthorization> {
    const [config, workspace] = await Promise.all([
      (this.options.loadConfig ?? loadExtensionConfig)(),
      this.workspace,
    ]);
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
    signal?: AbortSignal,
  ): Promise<FilesystemAuthorization> {
    const authorization = await this.authorize(path, operation);
    if (authorization.decision !== "ask") return authorization;
    if (await this.withinRuntimeTemp(authorization)) return { ...authorization, decision: "allow" };
    if (!ctx.hasUI) return authorization;
    if (this.isSessionApproved(authorization, operation)) return { ...authorization, decision: "allow" };

    const key = `${authorization.path}:${operation}`;
    let prompt = this.pendingPrompts.get(key);
    if (prompt === undefined) {
      prompt = this.promptAccess(authorization, operation, label, ctx, key, signal);
      this.pendingPrompts.set(key, prompt);
    }

    return prompt;
  }

  private async promptAccess(
    authorization: FilesystemAuthorization,
    operation: FilesystemOperation,
    label: string,
    ctx: ExtensionContext,
    key: string,
    signal?: AbortSignal,
  ): Promise<FilesystemAuthorization> {
    try {
      return await this.confirmationQueue.prompt(async (queueSignal) => {
        if (this.isSessionApproved(authorization, operation)) {
          return { ...authorization, decision: "allow" };
        }

        const workspace = await this.workspace;
        const projectRoot = await detectProjectRoot(authorization.path, { boundary: workspace.canonicalRoot });
        const ruleAccess: FilesystemRuleAccess = operation === "read" ? "read-only" : "read-write";

        if (typeof ctx.ui?.select === "function") {
          return this.promptSelect(authorization, label, projectRoot, ruleAccess, ctx, queueSignal);
        }

        return this.promptConfirm(authorization, label, ruleAccess, ctx, queueSignal);
      }, authorization, signal);
    } finally {
      this.pendingPrompts.delete(key);
    }
  }

  private async promptSelect(
    authorization: FilesystemAuthorization,
    label: string,
    projectRoot: string | undefined,
    ruleAccess: FilesystemRuleAccess,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<FilesystemAuthorization> {
    const fileLabel = basename(authorization.path);
    const allowFileOnce = projectRoot !== undefined
      ? `Allow file once (${fileLabel})`
      : "Allow file once";
    const projectPattern = projectRoot !== undefined
      ? `${projectRoot.replace(/\/+$/, "")}/**`
      : undefined;
    const allowProjectSession = projectPattern !== undefined
      ? `Allow project for this session (${projectPattern})`
      : undefined;
    const alwaysAllowProject = projectPattern !== undefined
      ? `Always allow project (${projectPattern})`
      : undefined;
    const alwaysAllowFile = projectPattern === undefined
      ? "Always allow file"
      : undefined;
    const deny = "Deny";

    const options = [
      allowFileOnce,
      ...(allowProjectSession ? [allowProjectSession] : []),
      ...(alwaysAllowProject ? [alwaysAllowProject] : []),
      ...(alwaysAllowFile ? [alwaysAllowFile] : []),
      deny,
    ];

    const choice = await ctx.ui.select!(
      `Allow ${label} access to ${authorization.path}?`,
      options,
      { timeout: CONFIRMATION_TIMEOUT_MS, signal },
    );

    if (choice === allowProjectSession && projectPattern !== undefined) {
      this.sessionApprovals.push({ pattern: projectPattern, access: ruleAccess });
      ctx.ui.notify(
        `User approved outside-workspace project access: ${label} ${projectPattern}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    if (choice === alwaysAllowProject && projectPattern !== undefined) {
      this.sessionApprovals.push({ pattern: projectPattern, access: ruleAccess });
      await this.persistRule({ path: projectPattern, access: ruleAccess }, ctx);
      ctx.ui.notify(
        `User permanently approved outside-workspace project access: ${label} ${projectPattern}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    if (choice === alwaysAllowFile) {
      this.sessionApprovals.push({ pattern: authorization.path, access: ruleAccess });
      await this.persistRule({ path: authorization.path, access: ruleAccess }, ctx);
      ctx.ui.notify(
        `User permanently approved outside-workspace access: ${label} ${authorization.path}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    if (choice === allowFileOnce) {
      this.sessionApprovals.push({ pattern: authorization.path, access: ruleAccess });
      ctx.ui.notify(
        `User approved outside-workspace access: ${label} ${authorization.path}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    ctx.ui.notify(
      `User denied outside-workspace access: ${label} ${authorization.path}`,
      "warning",
    );
    return authorization;
  }

  private async promptConfirm(
    authorization: FilesystemAuthorization,
    label: string,
    ruleAccess: FilesystemRuleAccess,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<FilesystemAuthorization> {
    const allowed = await ctx.ui.confirm(
      "Outside workspace access",
      `Allow ${label} access to ${authorization.path}?`,
      { timeout: CONFIRMATION_TIMEOUT_MS, signal },
    );

    if (allowed) {
      this.sessionApprovals.push({ pattern: authorization.path, access: ruleAccess });
      ctx.ui.notify(
        `User approved outside-workspace access: ${label} ${authorization.path}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    ctx.ui.notify(
      `User denied outside-workspace access: ${label} ${authorization.path}`,
      "warning",
    );
    return authorization;
  }

  private async persistRule(rule: FilesystemRule, ctx: ExtensionContext): Promise<void> {
    try {
      if (this.options.persistRule) {
        await this.options.persistRule(rule);
      } else {
        await appendAllowedFilesystemRule(rule);
      }
    } catch (error) {
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Failed to persist filesystem access to config: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    }
  }

  private isSessionApproved(target: FilesystemAuthorization, operation: FilesystemOperation): boolean {
    for (const { pattern, access } of this.sessionApprovals) {
      const matches = matchesFilesystemSelector(pattern, target.path) ||
        matchesFilesystemSelector(pattern, target.canonicalPath);
      if (matches && decisionForAccess(access, operation) === "allow") {
        return true;
      }
    }
    return false;
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

  clear(): void {
    this.sessionApprovals.length = 0;
    this.pendingPrompts.clear();
  }
}
