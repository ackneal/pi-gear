import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  appendAllowedFilesystemRule,
  loadExtensionConfig,
  type AccessPolicy,
  type FilesystemAccess as FilesystemRuleAccess,
  type FilesystemRule,
} from "../../config/index.ts";
import { ConfirmationQueue } from "../confirmation-queue.ts";
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
import { detectProjectRoot } from "./project.ts";
import { promptFilesystemAccess, type FilesystemPromptChoice } from "./prompt.ts";

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

interface PendingPrompt {
  readonly controller: AbortController;
  readonly promise: Promise<FilesystemAuthorization>;
  callers: number;
}

const awaitWithSignal = (
  promise: Promise<FilesystemAuthorization>,
  fallback: FilesystemAuthorization,
  release: () => void,
  signal?: AbortSignal,
): Promise<FilesystemAuthorization> => {
  if (signal?.aborted) {
    release();
    return Promise.resolve(fallback);
  }
  if (signal === undefined) return promise.finally(release);

  return new Promise<FilesystemAuthorization>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      release();
      resolve(fallback);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (result) => { signal.removeEventListener("abort", onAbort); release(); resolve(result); },
      (error) => { signal.removeEventListener("abort", onAbort); release(); reject(error); },
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
  private readonly pendingPrompts = new Map<string, PendingPrompt>();
  private generation = 0;

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
    const effectiveConfig = { ...config, filesystem: { rules: this.getEffectiveRules(config.filesystem.rules, operation) } };
    const normalized = normalizeToolPath(path, workspace.cwd);
    const selected = operation === "read" ? await selectReadPath(normalized) : normalized;
    const target = await resolveAccessTarget(selected, workspace);
    const decision = mostRestrictiveFilesystemDecision([
      evaluateFilesystem(effectiveConfig, workspace.cwd, target.path, operation),
      evaluateFilesystem(
        effectiveConfig,
        workspace.canonicalRoot,
        target.canonicalPath,
        operation,
        followFallbackAccess(effectiveConfig, workspace.cwd, target.path),
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
    if (signal?.aborted) return { ...authorization, decision: authorization.decision === "deny" ? "deny" : "ask" };
    if (authorization.decision !== "ask") return authorization;
    const withinTemp = await this.withinRuntimeTemp(authorization);
    if (signal?.aborted) return authorization;
    if (withinTemp) return { ...authorization, decision: "allow" };
    if (!ctx.hasUI) return authorization;

    const key = `${authorization.path}:${operation}`;
    let prompt = this.pendingPrompts.get(key);
    if (prompt === undefined) {
      const controller = new AbortController();
      prompt = {
        controller,
        callers: 0,
        promise: this.promptAccess(authorization, operation, label, ctx, controller.signal).finally(() => {
          if (this.pendingPrompts.get(key) === prompt) this.pendingPrompts.delete(key);
        }),
      };
      this.pendingPrompts.set(key, prompt);
    }

    const shared = prompt;
    shared.callers++;
    let released = false;
    return awaitWithSignal(shared.promise, authorization, () => {
      if (released) return;
      released = true;
      if (--shared.callers === 0) {
        if (this.pendingPrompts.get(key) === shared) this.pendingPrompts.delete(key);
        shared.controller.abort();
      }
    }, signal);
  }

  private async promptAccess(
    authorization: FilesystemAuthorization,
    operation: FilesystemOperation,
    label: string,
    ctx: ExtensionContext,
    signal: AbortSignal,
  ): Promise<FilesystemAuthorization> {
    const promptGeneration = this.generation;
    return this.confirmationQueue.prompt(async (queueSignal) => {
      if (queueSignal.aborted || this.generation !== promptGeneration) return authorization;
      const current = await this.authorize(authorization.path, operation);
      if (current.decision !== "ask") return current;

      const workspace = await this.workspace;
      const projectRoot = await detectProjectRoot(authorization.path, { boundary: workspace.canonicalRoot });
      const ruleAccess: FilesystemRuleAccess = operation === "read" ? "read-only" : "read-write";
      const projectPattern = projectRoot !== undefined ? `${projectRoot.replace(/\/+$/, "")}/**` : undefined;

      const choice = await promptFilesystemAccess({
        path: authorization.path,
        label,
        projectPattern,
        ctx,
        signal: queueSignal,
      });

      if (queueSignal.aborted || this.generation !== promptGeneration) return authorization;

      return this.handlePromptChoice(
        choice,
        authorization,
        label,
        ruleAccess,
        projectPattern,
        ctx,
        () => !queueSignal.aborted && this.generation === promptGeneration,
      );
    }, authorization, signal);
  }

  private async handlePromptChoice(
    choice: FilesystemPromptChoice,
    authorization: FilesystemAuthorization,
    label: string,
    ruleAccess: FilesystemRuleAccess,
    projectPattern: string | undefined,
    ctx: ExtensionContext,
    isCurrent: () => boolean,
  ): Promise<FilesystemAuthorization> {
    if (!isCurrent()) return authorization;

    const project = choice === "allow-project" || choice === "always-allow-project";
    if (choice === "deny" || project && projectPattern === undefined) {
      ctx.ui.notify(`User denied outside-workspace access: ${label} ${authorization.path}`, "warning");
      return authorization;
    }

    const pattern = project ? projectPattern! : authorization.path;
    const target = await resolveAccessTarget(project ? pattern.slice(0, -3) : pattern, await this.workspace);
    const canonicalPattern = project ? `${target.canonicalPath}/**` : target.canonicalPath;
    if (!isCurrent()) return authorization;

    const permanent = choice === "always-allow-file" || choice === "always-allow-project";
    if (permanent) {
      await this.persistRule({
        path: pattern,
        access: ruleAccess,
        ...(!project && target.path !== target.canonicalPath ? { follow: true } : {}),
      }, ctx);
      if (!isCurrent()) return authorization;
    }

    // Keep alias spellings and their resolved boundary in the same policy used by Bash.
    this.addSessionApproval(pattern, ruleAccess);
    // Policy selectors cannot represent literal stars in a resolved filename.
    if (!target.canonicalPath.includes("*")) this.addSessionApproval(canonicalPattern, ruleAccess);
    ctx.ui.notify(
      `User ${permanent ? "permanently approved" : "approved"} outside-workspace${project ? " project" : ""} access: ${label} ${pattern}`,
      "info",
    );
    return project ? this.authorize(authorization.path, ruleAccess === "read-only" ? "read" : "write")
      : { ...authorization, decision: "allow" };
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

  getEffectiveRules(
    baseRules: readonly FilesystemRule[] = [],
    operation?: FilesystemOperation,
  ): readonly FilesystemRule[] {
    const rules = [...baseRules];
    for (const approval of this.sessionApprovals) {
      // A read approval does not deny a later request to approve writes.
      if (operation === "write" && approval.access === "read-only") continue;
      const existingIndex = rules.findIndex((r) => r.path === approval.pattern);
      if (existingIndex >= 0) {
        const existing = rules[existingIndex]!;
        // Explicit deny must always take precedence over session approval.
        if (existing.access === "deny") continue;

        const access: FilesystemRuleAccess = existing.access === "read-write" || approval.access === "read-write"
          ? "read-write"
          : approval.access;
        rules[existingIndex] = { ...existing, path: existing.path, access };
      } else {
        rules.push({ path: approval.pattern, access: approval.access });
      }
    }
    return rules;
  }

  clear(): void {
    ++this.generation;
    this.sessionApprovals.length = 0;
    for (const prompt of this.pendingPrompts.values()) prompt.controller.abort();
    this.pendingPrompts.clear();
  }
}
