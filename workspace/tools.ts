import { createFindToolDefinition, createGrepToolDefinition, formatSize, truncateHead, truncateLine, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { GrepCursor, GrepMatch, GrepOptions } from "@ff-labs/fff-node";
import type { FilesystemAccess, FilesystemAuthorization } from "../execution/filesystem/access.ts";
import { isPathWithin, nativeGrep } from "./native.ts";
import type { WorkspaceSearch } from "./service.ts";
import { workspaceToolRenderers } from "../ui/tools/index.ts";

const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const INTERNAL_PAGE_SIZE = 100;
const posix = (path: string): string => path.split(sep).join("/");
const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

async function pathInfo(path: string) {
  try {
    return await stat(path);
  } catch {
    throw new Error(`Path not found: ${path}`);
  }
}

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

const findParameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
}, { additionalProperties: false });

const grepParameters = Type.Object({
  pattern: Type.String(),
  path: Type.Optional(Type.String()),
  glob: Type.Optional(Type.String()),
  ignoreCase: Type.Optional(Type.Boolean()),
  literal: Type.Optional(Type.Boolean()),
  context: Type.Optional(Type.Number({ minimum: 0 })),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
}, { additionalProperties: false });

function appendNotices(content: string, notices: readonly (string | undefined)[]): string {
  const visible = notices.filter((notice): notice is string => notice !== undefined);
  return visible.length === 0 ? content : `${content}\n\n[${visible.join(". ")}]`;
}

function findOutput(paths: readonly string[], limit: number, exhausted: boolean) {
  if (paths.length === 0) {
    return { content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined };
  }

  const truncation = truncateHead(paths.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const resultLimitReached = paths.length >= limit && !exhausted;
  const text = appendNotices(truncation.content, [
    resultLimitReached ? `${limit} results limit reached` : undefined,
    truncation.truncated ? `${formatSize(truncation.maxBytes)} limit reached` : undefined,
  ]);
  const details = resultLimitReached || truncation.truncated
    ? {
        ...(resultLimitReached ? { resultLimitReached: limit } : {}),
        ...(truncation.truncated ? { truncation } : {}),
      }
    : undefined;

  return { content: [{ type: "text" as const, text }], details };
}

interface RootAuthorization {
  readonly authorization: FilesystemAuthorization;
  readonly approvedAsk: boolean;
}

async function authorizeRoot(access: FilesystemAccess, root: string, label: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<RootAuthorization> {
  const initial = await access.authorize(root, "read");
  if (initial.decision === "deny") throw new Error("Access is not permitted.");
  if (initial.decision === "allow") return { authorization: initial, approvedAsk: false };

  const authorization = await access.request(root, "read", label, ctx, pi);
  if (authorization.decision === "deny") throw new Error("Access is not permitted.");
  if (authorization.decision === "ask") throw new Error("Access outside the workspace requires confirmation.");
  return { authorization, approvedAsk: true };
}

function approvedRootAccess(access: FilesystemAccess, root: RootAuthorization): Pick<FilesystemAccess, "permits"> {
  return {
    permits: async (path, operation = "read") => {
      const authorization = await access.authorize(path, operation);
      if (authorization.decision !== "ask") return authorization.decision === "allow";
      if (!root.approvedAsk) return false;

      return isPathWithin(root.authorization.path, authorization.path)
        && isPathWithin(root.authorization.canonicalPath, authorization.canonicalPath);
    },
  };
}

async function workspaceFind(search: WorkspaceSearch, root: string, pattern: string, limit: number) {
  const prefix = root === search.root ? "" : `${posix(relative(search.root, root)).replace(/\/$/, "")}/`;
  const target = limit + 1;
  const paths: string[] = [];
  let pageIndex = 0;
  let exhausted = false;
  while (paths.length < target && !exhausted) {
    const pageSize = Math.max(INTERNAL_PAGE_SIZE, target);
    const page = await search.glob(`${prefix}${pattern}`, { pageIndex, pageSize });
    for (const item of page.items) {
      if (prefix && !item.relativePath.startsWith(prefix)) continue;
      paths.push(prefix ? item.relativePath.slice(prefix.length) : item.relativePath);
      if (paths.length === target) break;
    }
    pageIndex++;
    exhausted = page.items.length === 0 || pageIndex * pageSize >= page.totalMatched;
  }
  return findOutput(paths.slice(0, limit), limit, exhausted && paths.length <= limit);
}

async function executeFind(
  search: WorkspaceSearch,
  access: FilesystemAccess,
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pattern: string,
  rawPath: string | undefined,
  limit: number,
  runExternal: (root: string) => ReturnType<ReturnType<typeof createFindToolDefinition>["execute"]>,
) {
  const requestedRoot = resolve(search.root, rawPath ?? ".");
  if (isPathWithin(search.root, requestedRoot)) {
    await pathInfo(requestedRoot);
    return workspaceFind(search, requestedRoot, pattern, limit);
  }

  const root = await authorizeRoot(access, requestedRoot, "find", ctx, pi);
  return runExternal(root.authorization.path);
}

interface DisplayMatch {
  relativePath: string;
  lineNumber: number;
  lineContent: string;
  contextBefore?: readonly string[];
  contextAfter?: readonly string[];
  gitStatus?: string;
  isDefinition?: boolean;
}

function groupMatchesByPath(matches: readonly DisplayMatch[]): Map<string, DisplayMatch[]> {
  const groups = new Map<string, DisplayMatch[]>();
  for (const match of matches) {
    const group = groups.get(match.relativePath);
    if (group) group.push(match);
    else groups.set(match.relativePath, [match]);
  }
  return groups;
}

function formatGrep(matches: readonly DisplayMatch[], limit: number, exhausted: boolean) {
  if (matches.length === 0) {
    return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  }

  const blocks: string[] = [];
  let linesTruncated = false;
  for (const [path, pathMatches] of groupMatchesByPath(matches)) {
    blocks.push(path);
    for (const match of pathMatches) {
      const before = match.contextBefore ?? [];
      for (const [index, content] of before.entries()) {
        blocks.push(`  ${match.lineNumber - before.length + index}- ${content}`);
      }

      const line = truncateLine(match.lineContent);
      linesTruncated ||= line.wasTruncated;
      blocks.push(`  ${match.lineNumber}:${match.isDefinition ? " [definition]" : ""} ${line.text}`);

      for (const [index, content] of (match.contextAfter ?? []).entries()) {
        blocks.push(`  ${match.lineNumber + index + 1}- ${content}`);
      }
    }
  }
  const truncation = truncateHead(blocks.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const reached = matches.length >= limit && !exhausted;
  const text = appendNotices(truncation.content, [
    reached ? `${limit} matches limit reached` : undefined,
    truncation.truncated ? `${formatSize(truncation.maxBytes)} limit reached` : undefined,
    linesTruncated ? "Some lines truncated; use read to inspect them" : undefined,
  ]);
  return {
    content: [{ type: "text" as const, text }],
    details: reached ? { matchLimitReached: limit } : undefined,
  };
}

function canUseFffGrep(pattern: string): boolean {
  return !/[\s/:]/.test(pattern);
}

function fffGrepPattern(input: GrepInput): { mode: "plain" | "regex"; pattern: string } {
  if (!input.ignoreCase) {
    return { mode: input.literal ? "plain" : "regex", pattern: input.pattern };
  }

  const pattern = input.literal ? escapeRegex(input.pattern) : input.pattern;
  return { mode: "regex", pattern: `(?i:${pattern})` };
}

async function workspaceGrep(
  search: WorkspaceSearch,
  access: FilesystemAccess,
  root: string,
  rootIsFile: boolean,
  input: GrepInput,
) {
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  const context = input.context ?? 0;
  const relativeRoot = posix(relative(search.root, root));
  const prefix = root === search.root || rootIsFile ? "" : `${relativeRoot.replace(/\/$/, "")}/`;
  const constraints = [
    rootIsFile ? relativeRoot : prefix ? `${prefix}**/*` : undefined,
    input.glob,
  ].filter(Boolean).join(" ");
  const grep = fffGrepPattern(input);
  const target = limit + 1;
  const matches: GrepMatch[] = [];
  let cursor: GrepCursor | null = null;
  let exhausted = false;

  do {
    const options: GrepOptions = {
      mode: grep.mode,
      smartCase: false,
      cursor,
      beforeContext: context,
      afterContext: context,
      maxMatchesPerFile: target,
      pageSize: Math.max(INTERNAL_PAGE_SIZE, target - matches.length),
    };
    const query = `${constraints ? `${constraints} ` : ""}${grep.pattern}`;
    const result = await search.grep(query, options);
    cursor = result.nextCursor;

    const candidatePaths = result.items.map(({ relativePath }) =>
      resolve(search.root, relativePath));
    const allowedPaths = new Set(await access.filter(candidatePaths));
    for (const match of result.items) {
      const inRequestedRoot = rootIsFile
        ? match.relativePath === relativeRoot
        : !prefix || match.relativePath.startsWith(prefix);
      const allowed = allowedPaths.has(resolve(search.root, match.relativePath));
      if (!inRequestedRoot || !allowed) continue;

      matches.push(match);
      if (matches.length === target) break;
    }
    exhausted = cursor === null;
  } while (!exhausted && matches.length < target);

  const visibleMatches = matches.slice(0, limit).map((match) => ({
    ...match,
    relativePath: rootIsFile
      ? relativeRoot.split("/").at(-1)!
      : prefix
        ? match.relativePath.slice(prefix.length)
        : match.relativePath,
  }));
  return formatGrep(visibleMatches, limit, exhausted && matches.length <= limit);
}

async function nativeGrepOutput(
  root: string,
  access: Pick<FilesystemAccess, "permits">,
  input: GrepInput,
  signal?: AbortSignal,
) {
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  const matches = await nativeGrep(root, access, input.pattern, {
    regex: !input.literal,
    ignoreCase: input.ignoreCase ?? false,
    ...(input.glob ? { glob: input.glob } : {}),
    context: input.context ?? 0,
    limit: limit + 1,
  }, signal);
  return formatGrep(matches.slice(0, limit), limit, matches.length <= limit);
}

async function executeGrep(search: WorkspaceSearch, access: FilesystemAccess, pi: ExtensionAPI, ctx: ExtensionContext, input: GrepInput, signal?: AbortSignal) {
  const requestedRoot = resolve(search.root, input.path ?? ".");
  if (isPathWithin(search.root, requestedRoot)) {
    const info = await pathInfo(requestedRoot);
    return canUseFffGrep(input.pattern)
      ? workspaceGrep(search, access, requestedRoot, info.isFile(), input)
      : nativeGrepOutput(requestedRoot, access, input, signal);
  }

  const root = await authorizeRoot(access, requestedRoot, "grep", ctx, pi);
  await pathInfo(root.authorization.path);
  return nativeGrepOutput(root.authorization.path, approvedRootAccess(access, root), input, signal);
}

export function registerWorkspaceTools(pi: ExtensionAPI, search: WorkspaceSearch, access: FilesystemAccess): void {
  const builtinFind = createFindToolDefinition(search.root);
  const findUi = workspaceToolRenderers("find");
  pi.registerTool({
    ...builtinFind,
    ...findUi,
    parameters: findParameters,
    execute: async (id, { pattern, path, limit }, signal, onUpdate, ctx) =>
      executeFind(
        search,
        access,
        pi,
        ctx,
        pattern,
        path,
        limit ?? DEFAULT_FIND_LIMIT,
        (root) => builtinFind.execute(id, {
          pattern,
          path: root,
          ...(limit === undefined ? {} : { limit }),
        }, signal, onUpdate, ctx),
      ),
  });

  const grep = createGrepToolDefinition(search.root);
  const grepUi = workspaceToolRenderers("grep");
  pi.registerTool({
    ...grep,
    ...grepUi,
    renderCall: grepUi.renderCall as any,
    renderResult: grepUi.renderResult as any,
    parameters: grepParameters,
    execute: async (_id, input, signal, _onUpdate, ctx) =>
      executeGrep(search, access, pi, ctx, input, signal),
  });

  pi.setActiveTools([...new Set([...pi.getActiveTools(), "find", "grep"])]);
}
