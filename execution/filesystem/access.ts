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

const awaitWithSignal = (
  promise: Promise<FilesystemAuthorization>,
  fallback: FilesystemAuthorization,
  signal?: AbortSignal,
): Promise<FilesystemAuthorization> => {
  if (signal?.aborted) return Promise.resolve(fallback);
  if (signal === undefined) return promise;

  return new Promise<FilesystemAuthorization>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      resolve(fallback);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { signal.removeEventListener("abort", onAbort); resolve(result); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
};

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
      prompt = this.promptAccess(authorization, operation, label, ctx, key);
      this.pendingPrompts.set(key, prompt);
    }

    return awaitWithSignal(prompt, authorization, signal);
  }

  private async promptAccess(
    authorization: FilesystemAuthorization,
    operation: FilesystemOperation,
    label: string,
    ctx: ExtensionContext,
    key: string,
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
      }, authorization);
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
    const allowFileOnce = `Allow file once (${fileLabel})`;
    const allowFileSession = `Allow file for this session (${fileLabel})`;
    const alwaysAllowFile = `Always allow file (${fileLabel})`;

    const projectPattern = projectRoot !== undefined
      ? `${projectRoot.replace(/\/+$/, "")}/**`
      : undefined;
    const allowProjectSession = projectPattern !== undefined
      ? `Allow project for this session (${projectPattern})`
      : undefined;
    const alwaysAllowProject = projectPattern !== undefined
      ? `Always allow project (${projectPattern})`
      : undefined;
    const deny = "Deny";

    const options = [
      allowFileOnce,
      allowFileSession,
      ...(allowProjectSession ? [allowProjectSession] : []),
      alwaysAllowFile,
      ...(alwaysAllowProject ? [alwaysAllowProject] : []),
      deny,
    ];

    const choice = await ctx.ui.select!(
      `Allow ${label} access to ${authorization.path}?`,
      options,
      { timeout: CONFIRMATION_TIMEOUT_MS, signal },
    );

    if (choice === allowProjectSession && projectPattern !== undefined) {
      this.addSessionApproval(projectPattern, ruleAccess);
      ctx.ui.notify(
        `User approved outside-workspace project access: ${label} ${projectPattern}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    if (choice === alwaysAllowProject && projectPattern !== undefined) {
      this.addSessionApproval(projectPattern, ruleAccess);
      await this.persistRule({ path: projectPattern, access: ruleAccess }, ctx);
      ctx.ui.notify(
        `User permanently approved outside-workspace project access: ${label} ${projectPattern}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    if (choice === allowFileSession) {
      this.addSessionApproval(authorization.path, ruleAccess);
      ctx.ui.notify(
        `User approved outside-workspace access: ${label} ${authorization.path}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    if (choice === alwaysAllowFile) {
      this.addSessionApproval(authorization.path, ruleAccess);
      await this.persistRule({ path: authorization.path, access: ruleAccess }, ctx);
      ctx.ui.notify(
        `User permanently approved outside-workspace access: ${label} ${authorization.path}`,
        "info",
      );
      return { ...authorization, decision: "allow" };
    }

    if (choice === allowFileOnce) {
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
      this.addSessionApproval(authorization.path, ruleAccess);
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

  private addSessionApproval(pattern: string, access: FilesystemRuleAccess): void {
    const existingIndex = this.sessionApprovals.findIndex((approval) => approval.pattern === pattern);
    if (existingIndex >= 0) {
      const existing = this.sessionApprovals[existingIndex];
      const mergedAccess: FilesystemRuleAccess = existing?.access === "read-write" || access === "read-write"
        ? "read-write"
        : access;
      this.sessionApprovals[existingIndex] = { pattern, access: mergedAccess };
      return;
    }

    this.sessionApprovals.push({ pattern, access });
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
