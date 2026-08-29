import { createFindToolDefinition, createGrepToolDefinition, formatSize, truncateHead, truncateLine, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import type { GrepCursor, GrepMatch, GrepOptions } from "@ff-labs/fff-node";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";
import { isPathWithin, nativeFind, nativeGrep } from "./native.ts";
import type { WorkspaceSearch } from "./service.ts";
import { workspaceToolRenderers } from "../ui/tools/index.ts";

const DEFAULT_FIND_LIMIT = 1000;
const DEFAULT_GREP_LIMIT = 100;
const INTERNAL_PAGE_SIZE = 100;
const posix = (path: string): string => path.split(sep).join("/");
const findParameters = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), limit: Type.Optional(Type.Number({ minimum: 1 })) }, { additionalProperties: false });
const grepParameters = Type.Object({ pattern: Type.String(), path: Type.Optional(Type.String()), glob: Type.Optional(Type.String()), ignoreCase: Type.Optional(Type.Boolean()), literal: Type.Optional(Type.Boolean()), context: Type.Optional(Type.Number({ minimum: 0 })), limit: Type.Optional(Type.Number({ minimum: 1 })) }, { additionalProperties: false });

function findOutput(paths: readonly string[], limit: number, exhausted: boolean) {
  if (!paths.length) return { content: [{ type: "text" as const, text: "No files found matching pattern" }], details: undefined };
  const truncation = truncateHead(paths.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const reached = paths.length >= limit && !exhausted;
  const notices = [reached ? `${limit} results limit reached` : undefined, truncation.truncated ? `${formatSize(truncation.maxBytes)} limit reached` : undefined].filter(Boolean);
  return { content: [{ type: "text" as const, text: `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}` }], details: reached || truncation.truncated ? { ...(reached ? { resultLimitReached: limit } : {}), ...(truncation.truncated ? { truncation } : {}) } : undefined };
}

async function authorizeRoot(access: FilesystemAccess, root: string, label: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<string> {
  const authorization = await access.request(root, "read", label, ctx, pi);
  if (authorization.decision === "deny") throw new Error("Access is not permitted.");
  if (authorization.decision === "ask") throw new Error("Access outside the workspace requires confirmation.");
  return authorization.path;
}

async function workspaceFind(search: WorkspaceSearch, access: FilesystemAccess, root: string, pattern: string, limit: number) {
  const prefix = root === search.root ? "" : `${posix(relative(search.root, root)).replace(/\/$/, "")}/`;
  const target = limit + 1;
  const paths: string[] = [];
  let pageIndex = 0;
  let exhausted = false;
  while (paths.length < target && !exhausted) {
    const pageSize = Math.max(INTERNAL_PAGE_SIZE, target);
    const page = await search.glob(`${prefix}${pattern}`, { pageIndex, pageSize });
    const allowed = new Set(await access.filter(page.items.map(({ relativePath }) => resolve(search.root, relativePath))));
    for (const item of page.items) {
      if (!allowed.has(resolve(search.root, item.relativePath)) || (prefix && !item.relativePath.startsWith(prefix))) continue;
      paths.push(prefix ? item.relativePath.slice(prefix.length) : item.relativePath);
      if (paths.length === target) break;
    }
    pageIndex++;
    exhausted = page.items.length === 0 || pageIndex * pageSize >= page.totalMatched;
  }
  return findOutput(paths.slice(0, limit), limit, exhausted && paths.length <= limit);
}

async function executeFind(search: WorkspaceSearch, access: FilesystemAccess, pi: ExtensionAPI, ctx: ExtensionContext, pattern: string, rawPath: string | undefined, limit: number) {
  const requestedRoot = resolve(search.root, rawPath ?? ".");
  if (isPathWithin(search.root, requestedRoot)) {
    await stat(requestedRoot).catch(() => { throw new Error(`Path not found: ${requestedRoot}`); });
    return workspaceFind(search, access, requestedRoot, pattern, limit);
  }

  const root = await authorizeRoot(access, requestedRoot, "find", ctx, pi);
  await stat(root).catch(() => { throw new Error(`Path not found: ${root}`); });
  const paths = await nativeFind(root, pattern, access, limit + 1);
  return findOutput(paths.slice(0, limit), limit, paths.length <= limit);
}

interface DisplayMatch { relativePath: string; lineNumber: number; lineContent: string; contextBefore?: readonly string[]; contextAfter?: readonly string[]; gitStatus?: string; isDefinition?: boolean; }
function formatGrep(matches: readonly DisplayMatch[], limit: number, exhausted: boolean) {
  if (!matches.length) return { content: [{ type: "text" as const, text: "No matches found" }], details: undefined };
  const groups = new Map<string, DisplayMatch[]>();
  for (const match of matches) groups.set(match.relativePath, [...(groups.get(match.relativePath) ?? []), match]);
  const blocks: string[] = [];
  let linesTruncated = false;
  for (const [path, items] of groups) {
    blocks.push(path);
    for (const match of items) {
      const before = match.contextBefore ?? [];
      before.forEach((line, i) => blocks.push(`  ${match.lineNumber - before.length + i}- ${line}`));
      const line = truncateLine(match.lineContent);
      linesTruncated ||= line.wasTruncated;
      blocks.push(`  ${match.lineNumber}:${match.isDefinition ? " [definition]" : ""} ${line.text}`);
      (match.contextAfter ?? []).forEach((value, i) => blocks.push(`  ${match.lineNumber + i + 1}- ${value}`));
    }
  }
  const truncation = truncateHead(blocks.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const reached = matches.length >= limit && !exhausted;
  const notices = [reached ? `${limit} matches limit reached` : undefined, truncation.truncated ? `${formatSize(truncation.maxBytes)} limit reached` : undefined, linesTruncated ? "Some lines truncated; use read to inspect them" : undefined].filter(Boolean);
  return { content: [{ type: "text" as const, text: `${truncation.content}${notices.length ? `\n\n[${notices.join(". ")}]` : ""}` }], details: reached ? { matchLimitReached: limit } : undefined };
}

async function workspaceGrep(search: WorkspaceSearch, access: FilesystemAccess, root: string, rootIsFile: boolean, input: { pattern: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }) {
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  const context = input.context ?? 0;
  const relativeRoot = posix(relative(search.root, root));
  const prefix = root === search.root || rootIsFile ? "" : `${relativeRoot.replace(/\/$/, "")}/`;
  const constraints = [rootIsFile ? relativeRoot : prefix ? `${prefix}**/*` : undefined, input.glob].filter(Boolean).join(" ");
  const target = limit + 1;
  const matches: GrepMatch[] = [];
  let cursor: GrepCursor | null = null;
  let exhausted = false;
  do {
    const options: GrepOptions = { mode: input.literal ? "plain" : "regex", smartCase: input.ignoreCase ?? false, cursor, beforeContext: context, afterContext: context, pageSize: Math.max(INTERNAL_PAGE_SIZE, target - matches.length) };
    const result = await search.grep(`${constraints ? `${constraints} ` : ""}${input.pattern}`, options);
    cursor = result.nextCursor;
    const allowed = new Set(await access.filter(result.items.map(({ relativePath }) => resolve(search.root, relativePath))));
    matches.push(...result.items.filter(({ relativePath }) => allowed.has(resolve(search.root, relativePath)) && (rootIsFile ? relativePath === relativeRoot : !prefix || relativePath.startsWith(prefix))));
    exhausted = cursor === null;
  } while (!exhausted && matches.length < target);
  return formatGrep(matches.slice(0, limit).map((match) => ({ ...match, relativePath: rootIsFile ? relativeRoot.split("/").at(-1)! : prefix ? match.relativePath.slice(prefix.length) : match.relativePath })), limit, exhausted && matches.length <= limit);
}

async function executeGrep(search: WorkspaceSearch, access: FilesystemAccess, pi: ExtensionAPI, ctx: ExtensionContext, input: { pattern: string; path?: string; glob?: string; ignoreCase?: boolean; literal?: boolean; context?: number; limit?: number }) {
  const requestedRoot = resolve(search.root, input.path ?? ".");
  if (isPathWithin(search.root, requestedRoot)) {
    const info = await stat(requestedRoot).catch(() => { throw new Error(`Path not found: ${requestedRoot}`); });
    return workspaceGrep(search, access, requestedRoot, info.isFile(), input);
  }

  const root = await authorizeRoot(access, requestedRoot, "grep", ctx, pi);
  await stat(root).catch(() => { throw new Error(`Path not found: ${root}`); });
  const limit = input.limit ?? DEFAULT_GREP_LIMIT;
  const matches = await nativeGrep(root, access, input.pattern, { regex: !input.literal, ignoreCase: input.ignoreCase ?? false, ...(input.glob ? { glob: input.glob } : {}), context: input.context ?? 0, limit: limit + 1 });
  return formatGrep(matches.slice(0, limit), limit, matches.length <= limit);
}

export function registerWorkspaceTools(pi: ExtensionAPI, search: WorkspaceSearch, access: FilesystemAccess): void {
  const find = createFindToolDefinition(search.root);
  const findUi = workspaceToolRenderers("find");
  pi.registerTool({ ...find, ...findUi, parameters: findParameters, execute: async (_id, { pattern, path, limit }, _signal, _onUpdate, ctx) => executeFind(search, access, pi, ctx, pattern, path, limit ?? DEFAULT_FIND_LIMIT) });

  const grep = createGrepToolDefinition(search.root);
  const grepUi = workspaceToolRenderers("grep");
  pi.registerTool({ ...grep, ...grepUi, renderCall: grepUi.renderCall as any, renderResult: grepUi.renderResult as any, parameters: grepParameters, execute: async (_id, input, _signal, _onUpdate, ctx) => executeGrep(search, access, pi, ctx, input) });

  pi.setActiveTools([...new Set([...pi.getActiveTools(), "find", "grep"])]);
}
