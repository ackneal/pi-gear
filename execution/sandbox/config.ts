import { execFile } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { matchesFilesystemSelector, selectorPath } from "../policy/filesystem.ts";
import type { AccessPolicy } from "../../config/types.ts";

export const validateRuntimePath = (path: string, source: string): string => {
  if (/[*?\[\]]/.test(path)) throw new Error(`${source} contains Sandbox Runtime glob metacharacters`);
  return path;
};

/** macOS aliases /tmp to /private/tmp; canonicalize before policy building so the alias cannot bypass rules. */
export const normalizeTempAlias = (path: string, platform: NodeJS.Platform = process.platform): string =>
  platform === "darwin" && (path === "/tmp" || path.startsWith("/tmp/")) ? `/private${path}` : path;

const normalizedSelectorPath = (selector: string, workspace: string): string =>
  normalizeTempAlias(selectorPath(selector, workspace));

export interface RuntimeTempDir {
  readonly path?: string;
  readonly warning?: string;
}

/** Supplies the raw OS temp directory spelling; the platform default is preferred over trusting $TMPDIR. */
export type TempDirSource = () => Promise<string | undefined>;

// confstr(_CS_DARWIN_USER_TEMP_DIR): the OS's own per-user temp directory,
// immune to a spoofed or stale TMPDIR in the process environment.
const getconfTempDirSource: TempDirSource = async () => {
  const { stdout } = await promisify(execFile)("getconf", ["DARWIN_USER_TEMP_DIR"]);
  return stdout.trim();
};

const envTempDirSource = (): TempDirSource => async () => process.env.TMPDIR?.trim();

export interface RuntimeTempOptions {
  readonly platform?: NodeJS.Platform;
  readonly source?: TempDirSource;
}

/**
 * Validates the OS temp directory as the implicit writable root. Failures
 * degrade to a warning, never a sandbox startup failure.
 */
export const resolveRuntimeTempDir = async (options: RuntimeTempOptions = {}): Promise<RuntimeTempDir> => {
  const platform = options.platform ?? process.platform;
  const source = options.source ?? (platform === "darwin" ? getconfTempDirSource : envTempDirSource());

  let raw: string | undefined;
  try {
    // Trim surrounding whitespace and getconf's trailing slash for clean prefix checks.
    raw = (await source())?.trim().replace(/\/+$/, "");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { warning: `Ignoring temp directory: ${reason}` };
  }
  if (!raw) return {};
  if (!isAbsolute(raw)) return { warning: `Ignoring temp directory (${raw}): not an absolute path` };
  try {
    const canonical = await realpath(normalizeTempAlias(raw, platform));
    if (!(await stat(canonical)).isDirectory()) {
      return { warning: `Ignoring temp directory (${raw}): not a directory` };
    }
    return { path: canonical };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { warning: `Ignoring temp directory (${raw}): ${reason}` };
  }
};

export interface RuntimeWritePaths {
  /** Validated process temp directory; an implementation detail, never written back to config. */
  readonly tempDir?: string | undefined;
}

export const createSandboxConfig = (workspaceRoot: string, policy: AccessPolicy, runtime: RuntimeWritePaths = {}): SandboxRuntimeConfig => {
  const workspace = validateRuntimePath(workspaceRoot, "workspace root");
  if (!isAbsolute(workspace)) throw new Error("workspace root must be absolute");
  const denyRead = policy.filesystem.rules
    .filter((rule) => rule.access === "deny")
    .map((rule) => normalizedSelectorPath(rule.path, workspace));
  const denyWrite = policy.filesystem.rules
    .filter((rule) => rule.access === "deny" || rule.access === "read-only")
    .map((rule) => normalizedSelectorPath(rule.path, workspace));
  const allowWrite = [...new Set([
    workspace,
    // Runtime temp exception; read access is already host-wide via allowRead: [], so no extra read rule.
    ...(runtime.tempDir !== undefined ? [validateRuntimePath(runtime.tempDir, "TMPDIR")] : []),
    ...policy.filesystem.rules
      .filter((rule) => rule.access === "read-write")
      .map((rule) => normalizedSelectorPath(rule.path, workspace)),
  ])];
  return {
    filesystem: {
      // The current policy intentionally permits host reads and protects sensitive paths with denyRead.
      allowRead: [],
      // Workspace and explicit read-write policy roots are writable; /tmp is configured as one such root.
      allowWrite,
      denyRead,
      // SRT injects persistent home writes; keep them outside the write boundary.
      denyWrite: [...denyWrite, selectorPath("~/.npm/_logs", workspace), selectorPath("~/.claude/debug", workspace)],
    },
    network: {
      allowedDomains: policy.network.rules.filter((rule) => rule.access === "allow").map((rule) => rule.host),
      deniedDomains: policy.network.rules.filter((rule) => rule.access === "deny").map((rule) => rule.host),
    },
    enableWeakerNetworkIsolation: true,
  };
};

const canonicalizeFollowPath = async (selector: string, workspace: string): Promise<string> => {
  const path = selectorPath(selector, workspace);
  const wildcardIndex = path.search(/[*?\[]/);
  if (wildcardIndex < 0) return realpath(path);

  const prefixEnd = path.lastIndexOf("/", wildcardIndex);
  const prefix = prefixEnd <= 0 ? "/" : path.slice(0, prefixEnd);
  return `${await realpath(prefix)}${path.slice(prefixEnd)}`;
};

const followedPolicyPaths = async (
  workspace: string,
  policy: AccessPolicy,
): Promise<ReadonlyMap<AccessPolicy["filesystem"]["rules"][number], string>> => {
  const followed = policy.filesystem.rules.filter((rule) => rule.follow);
  const paths = await Promise.all(followed.map(async (rule) => [
    rule,
    await canonicalizeFollowPath(rule.path, workspace),
  ] as const));
  return new Map(paths);
};

const deniedWorkspaceFiles = async (workspace: string, policy: AccessPolicy): Promise<readonly string[]> => {
  const denied: string[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relativePath = relativeDirectory === "" ? entry.name : `${relativeDirectory}/${entry.name}`;
      const absolutePath = join(directory, entry.name);
      if (policy.filesystem.rules.some((rule) => rule.access === "deny" && !rule.path.startsWith("/") && !rule.path.startsWith("~/") && matchesFilesystemSelector(rule.path, relativePath))) denied.push(absolutePath);
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(absolutePath, relativePath);
    }
  };
  await visit(workspace, "");
  return denied;
};

export const createEffectiveSandboxConfig = async (workspaceRoot: string, policy: AccessPolicy, runtime: RuntimeWritePaths = {}): Promise<SandboxRuntimeConfig> => {
  const config = createSandboxConfig(workspaceRoot, policy, runtime);
  const [deniedFiles, followedPaths] = await Promise.all([
    deniedWorkspaceFiles(workspaceRoot, policy),
    followedPolicyPaths(workspaceRoot, policy),
  ]);
  const followedRules = [...followedPaths.entries()];

  return {
    ...config,
    filesystem: {
      ...config.filesystem,
      allowWrite: [...new Set([
        ...(config.filesystem.allowWrite ?? []),
        ...followedRules
          .filter(([rule]) => rule.access === "read-write")
          .map(([, path]) => path),
      ])],
      denyRead: [...new Set([
        ...(config.filesystem.denyRead ?? []),
        ...deniedFiles,
        ...followedRules
          .filter(([rule]) => rule.access === "deny")
          .map(([, path]) => path),
      ])],
      denyWrite: [...new Set([
        ...(config.filesystem.denyWrite ?? []),
        ...followedRules
          .filter(([rule]) => rule.access === "deny" || rule.access === "read-only")
          .map(([, path]) => path),
      ])],
    },
  };
};
