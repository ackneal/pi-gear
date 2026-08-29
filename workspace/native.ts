import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFile } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";

export const isPathWithin = (root: string, path: string): boolean => {
  const candidate = relative(resolve(root), resolve(path));
  return candidate === "" || (candidate !== ".." && !candidate.startsWith(`..${sep}`));
};

const displayPath = (root: string, path: string): string => {
  const displayed = relative(root, path);
  return (displayed || basename(path)).split(sep).join("/");
};

function commandFailure(command: string, stderr: string, code: number | null): Error {
  return new Error(`${command} failed${code === null ? "" : ` with code ${code}`}: ${stderr.trim() || "unknown error"}`);
}

export async function nativeFind(root: string, pattern: string, access: FilesystemAccess, limit: number): Promise<string[]> {
  const child = spawn("fd", ["--glob", pattern, "--type", "f", "--color", "never", "--print0", ".", root], { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  const paths: string[] = [];
  let buffer = "";
  let stderr = "";
  let stopped = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  child.stdout.setEncoding("utf8");
  for await (const chunk of child.stdout) {
    buffer += chunk;
    for (;;) {
      const boundary = buffer.indexOf("\0");
      if (boundary < 0) break;
      const candidate = resolve(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 1);
      if (!await access.permits(candidate)) continue;
      paths.push(displayPath(root, candidate));
      if (paths.length < limit) continue;
      stopped = true;
      child.kill();
      break;
    }
    if (stopped) break;
  }

  const code = await closed;
  if (!stopped && code !== 0) throw commandFailure("fd", stderr, code);
  return paths;
}

export interface NativeGrepMatch {
  readonly relativePath: string;
  readonly lineNumber: number;
  readonly lineContent: string;
  readonly contextBefore: readonly string[];
  readonly contextAfter: readonly string[];
}

interface RgEvent {
  type: string;
  data?: {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
  };
}

export async function nativeGrep(root: string, access: FilesystemAccess, pattern: string, options: { regex: boolean; ignoreCase: boolean; glob?: string; context: number; limit: number }): Promise<NativeGrepMatch[]> {
  const args = ["--json", "--color", "never", ...(options.ignoreCase ? ["--ignore-case"] : []), ...(options.regex ? [] : ["--fixed-strings"]), ...(options.glob ? ["--glob", options.glob] : []), ...(options.context ? ["--context", String(options.context)] : []), "--", pattern, root];
  const child = spawn("rg", args, { stdio: ["ignore", "pipe", "pipe"] });
  const closed = new Promise<number | null>((resolveCode, reject) => {
    child.once("error", reject);
    child.once("close", resolveCode);
  });
  const lines = createInterface({ input: child.stdout });
  const matches: NativeGrepMatch[] = [];
  const permitted = new Map<string, boolean>();
  let stderr = "";
  let stopped = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  for await (const line of lines) {
    let event: RgEvent;
    try { event = JSON.parse(line) as RgEvent; } catch { continue; }
    if (event.type !== "match" || !event.data?.path?.text || event.data.line_number === undefined) continue;
    const absolutePath = resolve(event.data.path.text);
    let allowed = permitted.get(absolutePath);
    if (allowed === undefined) {
      allowed = await access.permits(absolutePath);
      permitted.set(absolutePath, allowed);
    }
    if (!allowed) continue;

    const lineNumber = event.data.line_number;
    let fileLines: string[] | undefined;
    if (options.context > 0) {
      try { fileLines = (await readFile(absolutePath, "utf8")).replace(/\r\n?/g, "\n").split("\n"); }
      catch { continue; }
    }
    matches.push({
      relativePath: displayPath(root, absolutePath),
      lineNumber,
      lineContent: fileLines?.[lineNumber - 1] ?? (event.data.lines?.text ?? "").replace(/\r?\n$/, ""),
      contextBefore: fileLines?.slice(Math.max(0, lineNumber - 1 - options.context), lineNumber - 1) ?? [],
      contextAfter: fileLines?.slice(lineNumber, lineNumber + options.context) ?? [],
    });
    if (matches.length < options.limit) continue;
    stopped = true;
    child.kill();
    break;
  }

  const code = await closed;
  if (!stopped && code !== 0 && code !== 1) throw commandFailure("rg", stderr, code);
  return matches;
}
