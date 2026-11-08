import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

const PROJECT_MARKERS = [
  "package.json",
  "Cargo.toml",
  "pyproject.toml",
  "go.mod",
  "deno.json",
  "deno.jsonc",
] as const;

const pathExists = async (target: string): Promise<boolean> => {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
};

const isDirectory = async (target: string): Promise<boolean> => {
  try {
    const stats = await stat(target);
    return stats.isDirectory();
  } catch {
    return false;
  }
};

const hasProjectMarker = async (directory: string): Promise<boolean> => {
  for (const marker of PROJECT_MARKERS) {
    if (await pathExists(resolve(directory, marker))) return true;
  }
  return false;
};

export interface DetectProjectRootOptions {
  readonly home?: string;
  readonly boundary?: string;
}

export const detectProjectRoot = async (
  targetPath: string,
  options: DetectProjectRootOptions = {},
): Promise<string | undefined> => {
  const home = resolve(options.home ?? homedir());
  const boundary = options.boundary !== undefined ? resolve(options.boundary) : undefined;
  const absoluteTarget = resolve(targetPath);
  let current = (await isDirectory(absoluteTarget)) ? absoluteTarget : dirname(absoluteTarget);

  let fallbackProject: string | undefined;

  while (current !== home && current !== boundary) {
    const parent = dirname(current);
    if (parent === current) break;

    if (await pathExists(resolve(current, ".git"))) return current;
    if (fallbackProject === undefined && await hasProjectMarker(current)) {
      fallbackProject = current;
    }

    current = parent;
  }

  return fallbackProject;
};
