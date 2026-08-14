import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import type { AccessPolicy, FilesystemAccess, FilesystemRule } from "../../config/index.ts";

export type FilesystemOperation = "read" | "write";
export type FilesystemDecision = "allow" | "ask" | "deny";

export const selectorPath = (selector: string, workspace: string): string =>
  selector.startsWith("~/")
    ? join(homedir(), selector.slice(2))
    : selector.startsWith("/")
      ? selector
      : join(workspace, selector);

export const isHostSelector = (selector: string): boolean =>
  selector.startsWith("~/") || selector.startsWith("/");

const globRegex = (pattern: string): RegExp => {
  let expression = "^";

  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] ?? "";
    if (character !== "*") {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      continue;
    }
    if (pattern[index + 1] !== "*") {
      expression += "[^/]*";
      continue;
    }

    index += 1;
    if (pattern[index + 1] === "/") {
      index += 1;
      expression += "(?:.*/)?";
    } else if (index === pattern.length - 1 && pattern[index - 2] === "/") {
      expression = expression.slice(0, -1);
      expression += "(?:/.*)?";
    } else {
      expression += ".*";
    }
  }

  return new RegExp(`${expression}$`);
};

export const matchesFilesystemSelector = (selector: string, workspacePath: string): boolean =>
  globRegex(selector).test(workspacePath);

const relativeWorkspacePath = (workspaceRoot: string, path: string): string | undefined => {
  const candidate = relative(workspaceRoot, path);
  if (candidate === "" || candidate.startsWith(`..${sep}`) || candidate === "..") {
    return candidate === "" ? "" : undefined;
  }
  return candidate.split(sep).join("/");
};

const matchingRules = (
  policy: AccessPolicy,
  workspaceRoot: string,
  path: string,
  workspacePath: string | undefined,
): FilesystemRule[] =>
  policy.filesystem.rules.filter((rule) => isHostSelector(rule.path)
    ? matchesFilesystemSelector(selectorPath(rule.path, workspaceRoot), path)
    : workspacePath !== undefined && matchesFilesystemSelector(rule.path, workspacePath));

const rank = (access: FilesystemAccess): number =>
  access === "deny" ? 3 : access === "read-only" ? 2 : 1;

const decisionForAccess = (
  access: FilesystemAccess,
  operation: FilesystemOperation,
): FilesystemDecision => access === "deny" || (access === "read-only" && operation === "write")
  ? "deny"
  : "allow";

export const evaluateFilesystem = (
  policy: AccessPolicy,
  workspaceRoot: string,
  path: string,
  operation: FilesystemOperation,
  followFallback?: FilesystemAccess,
): FilesystemDecision => {
  const workspacePath = relativeWorkspacePath(workspaceRoot, path);
  const matches = matchingRules(policy, workspaceRoot, path, workspacePath);

  let access: FilesystemAccess | undefined = workspacePath === undefined
    ? undefined
    : policy.filesystem.workspaceDefault;
  for (const rule of matches) {
    if (access === undefined || rank(rule.access) > rank(access)) access = rule.access;
  }

  if (access === undefined) {
    if (followFallback !== undefined) return decisionForAccess(followFallback, operation);
    return policy.filesystem.outsideWorkspaceDefault;
  }
  return decisionForAccess(access, operation);
};

/**
 * Most restrictive access among rules that opt into following symlinks
 * (`follow: true`) and match the given path. Used as the fallback access for
 * the symlink-resolved target, so explicit deny rules on the target still win.
 */
export const followFallbackAccess = (
  policy: AccessPolicy,
  workspaceRoot: string,
  path: string,
): FilesystemAccess | undefined => {
  const workspacePath = relativeWorkspacePath(workspaceRoot, path);
  let access: FilesystemAccess | undefined;
  for (const rule of matchingRules(policy, workspaceRoot, path, workspacePath)) {
    if (!rule.follow) continue;
    if (access === undefined || rank(rule.access) > rank(access)) access = rule.access;
  }
  return access;
};

export const mostRestrictiveFilesystemDecision = (
  decisions: readonly FilesystemDecision[],
): FilesystemDecision => decisions.includes("deny")
  ? "deny"
  : decisions.includes("ask")
    ? "ask"
    : "allow";
