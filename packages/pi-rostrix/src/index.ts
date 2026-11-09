import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProfileActivator } from "./core/activator.ts";
import { ProfileRegistry } from "./core/registry.ts";
import { ProfileResolver, type ParentContextLimits, type ResolvedProfile } from "./core/resolver.ts";
import type { ProfileDefinition } from "./core/schema.ts";
import { discoverAllProfiles, type DiscoveredProfile, type DiscoverProfilesOptions, type DiscoveryResult } from "./loader/discovery.ts";
import { setupInteractiveProfiles } from "./interactive/index.ts";
import { TaskRegistry } from "./runtime/task-registry.ts";
import { TaskSupervisor } from "./supervision/supervisor.ts";
import { registerRostrixTools } from "./tools/index.ts";

export * from "./core/schema.ts";
export * from "./core/registry.ts";
export * from "./core/resolver.ts";
export * from "./core/activator.ts";
export * from "./loader/index.ts";
export * from "./interactive/index.ts";
export * from "./runtime/session-runner.ts";
export * from "./runtime/task-types.ts";
export * from "./runtime/task-registry.ts";
export * from "./supervision/inbox.ts";
export * from "./supervision/wake-up.ts";
export * from "./supervision/supervisor.ts";
export * from "./tools/index.ts";

export const ROSTRIX_RUNTIME_SYMBOL = Symbol.for("pi.rostrix.runtime");

export interface RostrixOptions {
  autoRegisterTools?: boolean;
  autoLoadProfiles?: boolean;
  autoRegisterInteractive?: boolean;
}

export interface RostrixRuntime {
  readonly version: string;
  readonly isInitialized: boolean;
  readonly profiles: ProfileRegistry;
  readonly resolver: ProfileResolver;
  readonly activator: ProfileActivator;
  readonly tasks: TaskRegistry;
  readonly supervisor: TaskSupervisor;
  readonly discoveredProfiles: readonly DiscoveredProfile[];
  registerProfile(profile: ProfileDefinition): void;
  getProfile(id: string): ProfileDefinition | undefined;
  getAllProfiles(): ProfileDefinition[];
  resolveProfile(id: string, limits?: ParentContextLimits | undefined): ResolvedProfile;
  activateProfile(id: string): Promise<void>;
  deactivateProfile(): void;
  getActiveProfile(): ResolvedProfile | undefined;
  loadDiscoveredProfiles(options?: DiscoverProfilesOptions): Promise<DiscoveryResult>;
  dispose(): void;
}

class InProcessRostrixRuntime implements RostrixRuntime {
  readonly version = "0.1.0";
  private _initialized = false;
  private readonly _profiles = new ProfileRegistry();
  private readonly _resolver = new ProfileResolver(this._profiles);
  private readonly _activator: ProfileActivator;
  private readonly _tasks: TaskRegistry;
  private readonly _supervisor: TaskSupervisor;
  private readonly _pi: ExtensionAPI;
  private _discoveredProfiles: DiscoveredProfile[] = [];

  constructor(pi: ExtensionAPI, options: RostrixOptions = {}) {
    this._pi = pi;
    this._activator = new ProfileActivator(pi);
    this._tasks = new TaskRegistry();
    this._supervisor = new TaskSupervisor(this._tasks, pi);
    this._initialized = true;

    this._tasks.subscribe("*", (task) => {
      if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
        this._supervisor.notifyTaskSettled(task);
      }
    });

    if (options.autoRegisterTools !== false) {
      registerRostrixTools({
        pi,
        taskRegistry: this._tasks,
        profileRegistry: this._profiles,
        profileResolver: this._resolver,
      });
    }

    if (options.autoRegisterInteractive !== false) {
      setupInteractiveProfiles({ pi, runtime: this });
    }

    if (options.autoLoadProfiles !== false) {
      this.loadDiscoveredProfiles().catch(() => {});
    }

    pi.on("session_shutdown", () => {
      this.dispose();
    });
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  get profiles(): ProfileRegistry {
    return this._profiles;
  }

  get resolver(): ProfileResolver {
    return this._resolver;
  }

  get activator(): ProfileActivator {
    return this._activator;
  }

  get tasks(): TaskRegistry {
    return this._tasks;
  }

  get supervisor(): TaskSupervisor {
    return this._supervisor;
  }

  get discoveredProfiles(): readonly DiscoveredProfile[] {
    return this._discoveredProfiles;
  }

  registerProfile(profile: ProfileDefinition): void {
    this._profiles.register(profile);
  }

  getProfile(id: string): ProfileDefinition | undefined {
    return this._profiles.get(id);
  }

  getAllProfiles(): ProfileDefinition[] {
    return this._profiles.list();
  }

  resolveProfile(id: string, limits?: ParentContextLimits | undefined): ResolvedProfile {
    return this._resolver.resolve(id, limits);
  }

  async activateProfile(id: string): Promise<void> {
    const resolved = this.resolveProfile(id);
    await this._activator.activate(resolved);
  }

  deactivateProfile(): void {
    this._activator.deactivate();
  }

  getActiveProfile(): ResolvedProfile | undefined {
    return this._activator.activeProfile;
  }

  async loadDiscoveredProfiles(options?: DiscoverProfilesOptions): Promise<DiscoveryResult> {
    const result = await discoverAllProfiles(options);
    this._discoveredProfiles = [...result.profiles];

    for (const item of result.profiles) {
      this._profiles.register(item.profile);
    }

    return result;
  }

  dispose(): void {
    this._supervisor.dispose();
    this._activator.dispose();
    this._profiles.clear();
    this._discoveredProfiles = [];
    this._initialized = false;
    delete (globalThis as any)[ROSTRIX_RUNTIME_SYMBOL];
  }
}

export function initRostrix(pi: ExtensionAPI, options: RostrixOptions = {}): RostrixRuntime {
  const globalObj = globalThis as any;
  if (globalObj[ROSTRIX_RUNTIME_SYMBOL]) {
    return globalObj[ROSTRIX_RUNTIME_SYMBOL] as RostrixRuntime;
  }

  const runtime = new InProcessRostrixRuntime(pi, options);
  globalObj[ROSTRIX_RUNTIME_SYMBOL] = runtime;
  return runtime;
}
