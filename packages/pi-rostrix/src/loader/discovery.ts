import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import type { ProfileDefinition } from "../core/schema.ts";
import { parseProfileJson, parseProfileMarkdown, ProfileParseError } from "./parser.ts";

export interface DiscoveredProfile {
  readonly profile: ProfileDefinition;
  readonly filePath: string;
  readonly scope: "user" | "project" | "custom";
}

export interface DiscoverProfilesOptions {
  readonly cwd?: string | undefined;
  readonly userDir?: string | undefined;
  readonly projectDir?: string | undefined;
  readonly customDirs?: string[] | undefined;
  readonly onWarning?: ((warning: string) => void) | undefined;
}

export interface DiscoveryResult {
  readonly profiles: DiscoveredProfile[];
  readonly errors: { filePath: string; error: string }[];
}

export async function discoverAllProfiles(options: DiscoverProfilesOptions = {}): Promise<DiscoveryResult> {
  const userDirs = options.userDir
    ? [options.userDir]
    : [
        path.join(os.homedir(), ".pi", "agent", "rostrix"),
        path.join(os.homedir(), ".pi", "agent", "profiles"),
      ];

  const projectDirs = options.projectDir
    ? [options.projectDir]
    : [
        options.cwd ? path.join(options.cwd, ".pi", "rostrix") : path.join(process.cwd(), ".pi", "rostrix"),
        options.cwd ? path.join(options.cwd, ".pi", "profiles") : path.join(process.cwd(), ".pi", "profiles"),
      ];

  const userResults: DiscoveryResult[] = [];
  for (const dir of userDirs) {
    userResults.push(await scanDirectory(dir, "user", options.onWarning));
  }

  const projectResults: DiscoveryResult[] = [];
  for (const dir of projectDirs) {
    projectResults.push(await scanDirectory(dir, "project", options.onWarning));
  }

  const customResults: DiscoveryResult[] = [];
  if (options.customDirs) {
    for (const dir of options.customDirs) {
      customResults.push(await scanDirectory(dir, "custom", options.onWarning));
    }
  }

  // Merge with precedence: custom > project > user (and primary dir > fallback dir)
  const profilesById = new Map<string, DiscoveredProfile>();

  for (const result of userResults) {
    for (const item of result.profiles) {
      if (!profilesById.has(item.profile.id)) {
        profilesById.set(item.profile.id, item);
      }
    }
  }
  for (const result of projectResults) {
    for (const item of result.profiles) {
      profilesById.set(item.profile.id, item);
    }
  }
  for (const custom of customResults) {
    for (const item of custom.profiles) {
      profilesById.set(item.profile.id, item);
    }
  }

  const allErrors = [
    ...userResults.flatMap((r) => r.errors),
    ...projectResults.flatMap((r) => r.errors),
    ...customResults.flatMap((r) => r.errors),
  ];

  return {
    profiles: Array.from(profilesById.values()),
    errors: allErrors,
  };
}

export async function scanDirectory(
  dirPath: string,
  scope: "user" | "project" | "custom",
  onWarning?: ((warning: string) => void) | undefined,
): Promise<DiscoveryResult> {
  const profiles: DiscoveredProfile[] = [];
  const errors: { filePath: string; error: string }[] = [];

  let entries: string[];
  try {
    entries = await collectCandidateFiles(dirPath);
  } catch {
    return { profiles, errors };
  }

  for (const filePath of entries) {
    const ext = path.extname(filePath).toLowerCase();
    const fallbackId = path.basename(filePath, ext);

    try {
      const content = await fs.readFile(filePath, "utf-8");
      let profile: ProfileDefinition;

      if (ext === ".md") {
        profile = parseProfileMarkdown(content, { filePath, fallbackId });
      } else if (ext === ".json") {
        profile = parseProfileJson(content, { filePath, fallbackId });
      } else {
        continue;
      }

      profiles.push({ profile, filePath, scope });
    } catch (err) {
      const msg = err instanceof ProfileParseError ? err.message : String(err);
      errors.push({ filePath, error: msg });
      onWarning?.(`Failed to load profile from ${filePath}: ${msg}`);
    }
  }

  return { profiles, errors };
}

async function collectCandidateFiles(dirPath: string): Promise<string[]> {
  const files: string[] = [];

  async function traverse(current: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const fullPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        await traverse(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (ext === ".md" || ext === ".json") {
          files.push(fullPath);
        }
      }
    }
  }

  await traverse(dirPath);
  return files.sort();
}
