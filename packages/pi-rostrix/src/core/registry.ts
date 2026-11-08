import { Value } from "typebox/value";
import { ProfileDefinitionSchema, type ProfileDefinition } from "./schema.ts";

export class ProfileValidationError extends Error {
  readonly profileId?: string | undefined;
  readonly errors: Array<{ path: string; message: string }>;

  constructor(message: string, errors: Array<{ path: string; message: string }> = [], profileId?: string | undefined) {
    super(message);
    this.name = "ProfileValidationError";
    this.profileId = profileId;
    this.errors = errors;
  }
}

export class ProfileRegistry {
  private readonly _profiles = new Map<string, ProfileDefinition>();

  register(profile: ProfileDefinition): void {
    if (!profile || typeof profile !== "object") {
      throw new ProfileValidationError("Profile definition must be a non-null object", [
        { path: "", message: "Expected object" },
      ]);
    }

    const errors = [...Value.Errors(ProfileDefinitionSchema, profile)];
    if (errors.length > 0) {
      const formatted = errors.map((e) => ({
        path: (e as any).path ?? "",
        message: e.message,
      }));
      const id = typeof (profile as any).id === "string" ? (profile as any).id : undefined;
      throw new ProfileValidationError(
        `Invalid profile definition${id ? ` '${id}'` : ""}: ${formatted.map((e) => `${e.path || "root"}: ${e.message}`).join(", ")}`,
        formatted,
        id,
      );
    }

    if (this._profiles.has(profile.id)) {
      throw new Error(`Profile '${profile.id}' is already registered in this registry`);
    }

    this._profiles.set(profile.id, Object.freeze({ ...profile }));
  }

  unregister(id: string): boolean {
    return this._profiles.delete(id);
  }

  get(id: string): ProfileDefinition | undefined {
    return this._profiles.get(id);
  }

  has(id: string): boolean {
    return this._profiles.has(id);
  }

  list(): ProfileDefinition[] {
    return Array.from(this._profiles.values());
  }

  clear(): void {
    this._profiles.clear();
  }
}
