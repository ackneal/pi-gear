import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProfileActivator } from "./core/activator.ts";
import { ProfileRegistry } from "./core/registry.ts";
import { ProfileResolver, type ParentContextLimits, type ResolvedProfile } from "./core/resolver.ts";
import type { ProfileDefinition } from "./core/schema.ts";

export * from "./core/schema.ts";
export * from "./core/registry.ts";
export * from "./core/resolver.ts";
export * from "./core/activator.ts";

export const ROSTRIX_RUNTIME_SYMBOL = Symbol.for("pi.rostrix.runtime");
/** Legacy compatibility alias */
export const ROSTER_RUNTIME_SYMBOL = ROSTRIX_RUNTIME_SYMBOL;

export interface RostrixOptions {
  autoRegisterTools?: boolean;
}
export type RosterOptions = RostrixOptions;

export interface RostrixRuntime {
  readonly version: string;
  readonly isInitialized: boolean;
  readonly profiles: ProfileRegistry;
  readonly resolver: ProfileResolver;
  readonly activator: ProfileActivator;
  registerProfile(profile: ProfileDefinition): void;
  getProfile(id: string): ProfileDefinition | undefined;
  getAllProfiles(): ProfileDefinition[];
  resolveProfile(id: string, limits?: ParentContextLimits | undefined): ResolvedProfile;
  activateProfile(id: string): Promise<void>;
  getActiveProfile(): ResolvedProfile | undefined;
  dispose(): void;
}
export type RosterRuntime = RostrixRuntime;

class InProcessRostrixRuntime implements RostrixRuntime {
  readonly version = "0.1.0";
  private _initialized = false;
  private readonly _profiles = new ProfileRegistry();
  private readonly _resolver = new ProfileResolver(this._profiles);
  private readonly _activator: ProfileActivator;
  private readonly _pi: ExtensionAPI;

  constructor(pi: ExtensionAPI, options: RostrixOptions = {}) {
    this._pi = pi;
    this._activator = new ProfileActivator(pi);
    this._initialized = true;
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

  getActiveProfile(): ResolvedProfile | undefined {
    return this._activator.activeProfile;
  }

  dispose(): void {
    this._activator.dispose();
    this._profiles.clear();
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

/** Legacy compatibility alias */
export const initRoster = initRostrix;
