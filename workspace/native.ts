import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";

type SearchAccess = Pick<FilesystemAccess, "permits">;

export const isPathWithin = (root: string, path: string): boolean => {
  const candidate = relative(resolve(root), resolve(path));
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`));
};

function displayPath(root: string, path: string): string {
  const displayed = relative(root, path) || basename(path);
  return displayed.split(sep).join("/");
}

function commandFailure(command: string, stderr: string, code: number | null): Error {
  const status = code === null ? "" : ` with code ${code}`;
  return new Error(`${command} failed${status}: ${stderr.trim() || "unknown error"}`);
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
}

async function hasGitAncestor(root: string): Promise<boolean> {
  let directory = resolve(root);
  while (true) {
    try {
      await stat(join(directory, ".git"));
      return true;
    } catch {
      const parent = dirname(directory);
      if (parent === directory) return false;
      directory = parent;
    }
  }
}

function fdPattern(pattern: string): { pattern: string; fullPath: boolean } {
  if (!pattern.includes("/")) return { pattern, fullPath: false };

  const recursive = isAbsolute(pattern) || pattern.startsWith("**/") || pattern === "**"
    ? pattern
    : `**/${pattern}`;
  return {
    pattern: process.platform === "win32" ? recursive.replaceAll("/", "[/\\\\]") : recursive,
    fullPath: true,
  };
}

export async function nativeFind(
  root: string,
  pattern: string,
  limit: number,
  signal?: AbortSignal,
): Promise<string[]> {
  signal?.throwIfAborted();
  const effective = fdPattern(pattern);
  const args = [
    "--glob",
    "--color=never",
    "--hidden",
    ...(await hasGitAncestor(root) ? [] : ["--no-require-git"]),
    ...(effective.fullPath ? ["--full-path"] : []),
    "--type", "f",
    "--print0",
    "--", effective.pattern, root,
  ];
  const child = spawn("fd", args, { stdio: ["ignore", "pipe", "pipe"] });
  const abort = () => { child.kill(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const closed = waitForClose(child);
  const paths: string[] = [];
  let pending = "";
  let stderr = "";
  let stoppedAtLimit = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.setEncoding("utf8");

  try {
    for await (const chunk of child.stdout) {
      pending += chunk;
      let boundary: number;
      while ((boundary = pending.indexOf("\0")) >= 0) {
        const candidate = resolve(pending.slice(0, boundary));
        pending = pending.slice(boundary + 1);

        paths.push(displayPath(root, candidate));
        if (paths.length < limit) continue;

        stoppedAtLimit = true;
        child.kill();
        break;
      }
      if (stoppedAtLimit) break;
    }

    const code = await closed;
    signal?.throwIfAborted();
    if (!stoppedAtLimit && code !== 0) throw commandFailure("fd", stderr, code);
    return paths;
  } finally {
    child.kill();
    signal?.removeEventListener("abort", abort);
  }
}

export interface NativeGrepMatch {
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
}

interface RgMatchEvent {
  type: "match";
  data: {
    path: { text: string };
    lines?: { text?: string };
    line_number: number;
  };
}

function parseMatchEvent(line: string): RgMatchEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }

  const event = value as Partial<RgMatchEvent>;
  if (event.type !== "match" || !event.data?.path?.text || event.data.line_number === undefined) return undefined;
  return event as RgMatchEvent;
}

async function readLines(path: string): Promise<string[] | undefined> {
  try {
    return (await readFile(path, "utf8")).replace(/\r\n?/g, "\n").split("\n");
  } catch {
    // The rg match is still useful if the file changes or disappears after rg reads it.
    return undefined;
  }
}

function toNativeMatch(root: string, event: RgMatchEvent, fileLines: string[] | undefined, context: number): NativeGrepMatch {
  const absolutePath = resolve(event.data.path.text);
  const lineIndex = event.data.line_number - 1;
  const eventContent = (event.data.lines?.text ?? "").replace(/\r?\n$/, "");

  return {
    relativePath: displayPath(root, absolutePath),
    lineNumber: event.data.line_number,
    lineContent: fileLines?.[lineIndex] ?? eventContent,
    contextBefore: fileLines?.slice(Math.max(0, lineIndex - context), lineIndex) ?? [],
    contextAfter: fileLines?.slice(lineIndex + 1, lineIndex + 1 + context) ?? [],
  };
}

export async function nativeGrep(
  root: string,
  access: SearchAccess,
  pattern: string,
  options: { regex: boolean; ignoreCase: boolean; glob?: string; context: number; limit: number },
  signal?: AbortSignal,
): Promise<NativeGrepMatch[]> {
  signal?.throwIfAborted();
  const args = [
    "--json",
    "--color", "never",
    ...(options.ignoreCase ? ["--ignore-case"] : []),
    ...(options.regex ? [] : ["--fixed-strings"]),
    ...(options.glob ? ["--glob", options.glob] : []),
    "--", pattern, root,
  ];
  const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const abort = () => { child.kill(); };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const closed = waitForClose(child);
  const output = createInterface({ input: child.stdout });
  const matches: NativeGrepMatch[] = [];
  const permissionByPath = new Map<string, boolean>();
  const linesByPath = new Map<string, string[] | undefined>();
  let stderr = "";
  let stoppedAtLimit = false;

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    for await (const line of output) {
      const event = parseMatchEvent(line);
      if (!event) continue;

      const absolutePath = resolve(event.data.path.text);
      let permitted = permissionByPath.get(absolutePath);
      if (permitted === undefined) {
        permitted = await access.permits(absolutePath);
        permissionByPath.set(absolutePath, permitted);
      }
      if (!permitted) continue;

      let fileLines: string[] | undefined;
      if (options.context > 0) {
        if (!linesByPath.has(absolutePath)) linesByPath.set(absolutePath, await readLines(absolutePath));
        fileLines = linesByPath.get(absolutePath);
      }
      matches.push(toNativeMatch(root, event, fileLines, options.context));

      if (matches.length < options.limit) continue;
      stoppedAtLimit = true;
      child.kill();
      break;
    }

    const code = await closed;
    signal?.throwIfAborted();
    if (!stoppedAtLimit && code !== 0 && code !== 1) throw commandFailure("rg", stderr, code);
    return matches;
  } finally {
    output.close();
    child.kill();
    signal?.removeEventListener("abort", abort);
  }
}
