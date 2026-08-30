import { SandboxManager, type NetworkHostPattern, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import type { BashOperations, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateNetwork } from "../policy/network.ts";
import { canonicalizeWorkspace, type CanonicalWorkspace } from "../filesystem/paths.ts";
import { loadExtensionConfig } from "../../config/index.ts";
import { SessionApprovals } from "./approvals.ts";
import { createEffectiveSandboxConfig, resolveRuntimeTempDir } from "./config.ts";
import { createSandboxedBashOperations } from "./spawn.ts";
import { CONFIRMATION_TIMEOUT_MS, ConfirmationQueue } from "../confirmation-queue.ts";

export interface SandboxManagerLike {
  isSandboxingEnabled(): boolean;
  isSupportedPlatform(): boolean;
  checkDependenciesAsync(): Promise<{ readonly errors: readonly string[] }>;
  initialize(
    config: SandboxRuntimeConfig,
    ask: (request: NetworkHostPattern) => Promise<boolean>,
  ): Promise<void>;
  reset(): Promise<void>;
}

type SandboxState =
  | { readonly kind: "starting" }
  | {
      readonly kind: "ready";
      readonly workspace: CanonicalWorkspace;
      readonly config: SandboxRuntimeConfig;
    }
  | { readonly kind: "unavailable"; readonly reason: string }
  | { readonly kind: "stopped" };

export interface SandboxStatus {
  readonly configured: boolean;
  readonly enabled: boolean;
  readonly workspace: string;
  readonly reason: string | undefined;
  readonly network: { allowedDomains: readonly string[]; deniedDomains: readonly string[]; strictAllowlist: boolean } | undefined;
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);

export class SandboxController {
  private readonly sendApprovalMessage: (content: string) => void | Promise<void>;
  private readonly manager: SandboxManagerLike;
  private readonly loadConfig: typeof loadExtensionConfig;
  private readonly confirmationQueue: ConfirmationQueue;

  constructor(
    sendApprovalMessage: (content: string) => void | Promise<void>,
    manager: SandboxManagerLike = SandboxManager,
    loadConfig: typeof loadExtensionConfig = loadExtensionConfig,
    confirmationQueue: ConfirmationQueue = new ConfirmationQueue(),
  ) {
    this.sendApprovalMessage = sendApprovalMessage;
    this.manager = manager;
    this.loadConfig = loadConfig;
    this.confirmationQueue = confirmationQueue;
  }

  private state: SandboxState = { kind: "starting" };
  private generation = 0;
  private approvals: SessionApprovals | undefined;
  private lifecycle: Promise<void> = Promise.resolve();

  readonly operations: BashOperations = createSandboxedBashOperations({
    isAvailable: () => this.state.kind === "ready",
    unavailableReason: () => this.state.kind === "unavailable" ? this.state.reason : this.state.kind,
    onCleanupFailure: () => {
      this.state = { kind: "unavailable", reason: "sandbox command cleanup failed" };
    },
    onExecutionPrevented: (command, reason) => this.approvals?.notifyExecutionPrevented(command, reason),
    customConfigFor: () => this.sessionConfig(),
  });

  start(ctx: ExtensionContext): Promise<void> {
    return this.enqueue(() => this.startCurrent(ctx));
  }

  shutdown(): Promise<void> {
    return this.enqueue(() => this.shutdownCurrent());
  }

  private async startCurrent(ctx: ExtensionContext): Promise<void> {
    const generation = ++this.generation;
    this.approvals?.clear();
    let approvals: SessionApprovals;
    approvals = new SessionApprovals({
      hasUI: ctx.hasUI,
      confirm: (title, message) => this.confirmationQueue.confirm(() => ctx.ui.confirm(
        title,
        message,
        { timeout: CONFIRMATION_TIMEOUT_MS },
      )),
      notify: (message, level) => ctx.ui.notify(message, level),
      sendMessage: this.sendApprovalMessage,
    }, () => this.generation === generation && this.approvals === approvals);
    this.approvals = approvals;
    this.state = { kind: "starting" };
    let initializationAttempted = false;
    try {
      if (this.manager.isSandboxingEnabled()) await this.manager.reset();
      if (process.platform !== "darwin" || !this.manager.isSupportedPlatform()) {
        throw new Error(`platform ${process.platform} is unsupported`);
      }
      const [extensionConfig, workspace, tempDir] = await Promise.all([
        this.loadConfig(),
        canonicalizeWorkspace(ctx.cwd),
        resolveRuntimeTempDir(),
      ]);
      if (tempDir.warning !== undefined && ctx.hasUI) ctx.ui.notify(tempDir.warning, "warning");
      const policy = extensionConfig;
      const dependencies = await this.manager.checkDependenciesAsync();
      if (dependencies.errors.length > 0) throw new Error(dependencies.errors.join("; "));
      const config = await createEffectiveSandboxConfig(workspace.canonicalRoot, policy, { tempDir: tempDir.path });
      initializationAttempted = true;
      await this.manager.initialize(config, async (request: NetworkHostPattern) => {
        if (this.generation !== generation || this.approvals !== approvals) return false;
        const decision = evaluateNetwork(policy, request.host, request.port);
        if (decision === "deny") return false;
        if (decision === "allow") return true;
        return approvals.requestNetwork(request);
      });
      if (this.generation !== generation || this.approvals !== approvals) { await this.manager.reset(); return; }
      this.state = { kind: "ready", workspace, config };
    } catch (error) {
      let reason = errorMessage(error);
      if (
        (initializationAttempted || this.manager.isSandboxingEnabled())
        && this.generation === generation
        && this.approvals === approvals
      ) {
        try {
          await this.manager.reset();
        } catch (resetError) {
          reason += `; sandbox reset failed: ${errorMessage(resetError)}`;
        }
      }
      if (this.generation === generation && this.approvals === approvals) {
        this.state = { kind: "unavailable", reason };
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Sandbox unavailable: ${reason}\nBash and user_bash will not execute. No host fallback occurred.`,
            "warning",
          );
        }
      }
    }
  }

  private async shutdownCurrent(): Promise<void> {
    ++this.generation;
    this.approvals?.clear();
    this.approvals = undefined;
    if (this.state.kind === "ready" || this.manager.isSandboxingEnabled()) {
      try { await this.manager.reset(); } catch { /* Bash remains unavailable after cleanup failure. */ }
    }
    this.state = { kind: "stopped" };
  }

  status(): SandboxStatus {
    return this.state.kind === "ready"
      ? {
          configured: true,
          enabled: true,
          workspace: this.state.workspace.canonicalRoot,
          reason: undefined,
          network: {
            allowedDomains: this.state.config.network.allowedDomains ?? [],
            deniedDomains: this.state.config.network.deniedDomains ?? [],
            strictAllowlist: this.state.config.network.strictAllowlist ?? false,
          },
        }
      : { configured: true, enabled: false, workspace: "unavailable", reason: this.state.kind === "unavailable" ? this.state.reason : this.state.kind, network: undefined };
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const current = this.lifecycle.then(operation);
    this.lifecycle = current.catch(() => undefined);
    return current;
  }

  private async sessionConfig(): Promise<SandboxRuntimeConfig> {
    if (this.state.kind !== "ready" || this.approvals === undefined) {
      const reason = this.state.kind === "unavailable" ? this.state.reason : this.state.kind;
      throw new Error(`Sandbox unavailable: ${reason}`);
    }
    return this.state.config;
  }
}
