import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const ROSTER_RUNTIME_SYMBOL = Symbol.for("pi.roster.runtime");

export interface RosterOptions {
  autoRegisterTools?: boolean;
}

export interface RosterRuntime {
  readonly version: string;
  readonly isInitialized: boolean;
  registerProfile(profile: any): void;
  getProfile(id: string): any;
  getAllProfiles(): any[];
  dispose(): void;
}

class InProcessRosterRuntime implements RosterRuntime {
  readonly version = "0.1.0";
  private _initialized = false;
  private _profiles = new Map<string, any>();
  private _pi: ExtensionAPI;

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

  registerProfile(profile: any): void {
    if (!profile || typeof profile.id !== "string") {
      throw new Error("Invalid profile: missing string 'id'");
    }
    if (this._profiles.has(profile.id)) {
      throw new Error(`Profile '${profile.id}' is already registered`);
    }
    this._profiles.set(profile.id, profile);
  }

  getProfile(id: string): any {
    return this._profiles.get(id);
  }

  getAllProfiles(): any[] {
    return Array.from(this._profiles.values());
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
