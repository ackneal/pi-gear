import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ProfileRegistry } from "./core/registry.ts";
import type { ProfileDefinition } from "./core/schema.ts";

export * from "./core/schema.ts";
export * from "./core/registry.ts";

export const ROSTER_RUNTIME_SYMBOL = Symbol.for("pi.roster.runtime");

export interface RosterOptions {
  autoRegisterTools?: boolean;
}

export interface RosterRuntime {
  readonly version: string;
  readonly isInitialized: boolean;
  readonly profiles: ProfileRegistry;
  registerProfile(profile: ProfileDefinition): void;
  getProfile(id: string): ProfileDefinition | undefined;
  getAllProfiles(): ProfileDefinition[];
  dispose(): void;
}

class InProcessRosterRuntime implements RosterRuntime {
  readonly version = "0.1.0";
  private _initialized = false;
  private readonly _profiles = new ProfileRegistry();
  private readonly _pi: ExtensionAPI;

  constructor(pi: ExtensionAPI, options: RosterOptions = {}) {
    this._pi = pi;
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

  registerProfile(profile: ProfileDefinition): void {
    this._profiles.register(profile);
  }

  getProfile(id: string): ProfileDefinition | undefined {
    return this._profiles.get(id);
  }

  getAllProfiles(): ProfileDefinition[] {
    return this._profiles.list();
  }

  dispose(): void {
    this._profiles.clear();
    this._initialized = false;
    delete (globalThis as any)[ROSTER_RUNTIME_SYMBOL];
  }
}

export function initRoster(pi: ExtensionAPI, options: RosterOptions = {}): RosterRuntime {
  const globalObj = globalThis as any;
  if (globalObj[ROSTER_RUNTIME_SYMBOL]) {
    return globalObj[ROSTER_RUNTIME_SYMBOL] as RosterRuntime;
  }

  const runtime = new InProcessRosterRuntime(pi, options);
  globalObj[ROSTER_RUNTIME_SYMBOL] = runtime;
  return runtime;
}
