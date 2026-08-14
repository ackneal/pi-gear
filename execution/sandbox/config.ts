import { readdir, realpath } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { matchesFilesystemSelector, selectorPath } from "../policy/filesystem.ts";
import type { AccessPolicy } from "../../config/types.ts";

export const validateRuntimePath = (path: string, source: string): string => {
  if (/[*?\[\]]/.test(path)) throw new Error(`${source} contains Sandbox Runtime glob metacharacters`);
  return path;
};

export const createSandboxConfig = (workspaceRoot: string, policy: AccessPolicy): SandboxRuntimeConfig => {
  const workspace = validateRuntimePath(workspaceRoot, "workspace root");
  if (!isAbsolute(workspace)) throw new Error("workspace root must be absolute");
  const denyRead = policy.filesystem.rules
    .filter((rule) => rule.access === "deny")
    .map((rule) => selectorPath(rule.path, workspace));
  const denyWrite = policy.filesystem.rules
    .filter((rule) => rule.access === "deny" || rule.access === "read-only")
    .map((rule) => selectorPath(rule.path, workspace));
  const allowWrite = [...new Set([
    workspace,
    ...policy.filesystem.rules
      .filter((rule) => rule.access === "read-write")
      .map((rule) => selectorPath(rule.path, workspace)),
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

export const createEffectiveSandboxConfig = async (workspaceRoot: string, policy: AccessPolicy): Promise<SandboxRuntimeConfig> => {
  const config = createSandboxConfig(workspaceRoot, policy);
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
