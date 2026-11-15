import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GitFileState = "S" | "M" | "SM" | "?" | "U";

export interface GitStatusEntry {
  readonly path: string;
  readonly state: GitFileState;
}

export interface GitNumstatEntry {
  readonly path: string;
  readonly insertions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export interface GitFileDiff {
  readonly path: string;
  readonly state: GitFileState;
  readonly insertions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

export interface WorkspaceGitSnapshot {
  readonly isRepo: boolean;
  readonly branch?: string | undefined;
  readonly ahead: number;
  readonly behind: number;
  readonly files: readonly GitFileDiff[];
  readonly totalInsertions: number;
  readonly totalDeletions: number;
}

export const EMPTY_GIT_SNAPSHOT: WorkspaceGitSnapshot = {
  isRepo: false,
  ahead: 0,
  behind: 0,
  files: [],
  totalInsertions: 0,
  totalDeletions: 0,
};

function unquoteGitPath(raw: string): string {
  if (raw.startsWith("\"") && raw.endsWith("\"")) {
    return raw.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return raw;
}

function normalizeStatusPath(rawPath: string, isRenameOrCopy: boolean): string {
  const arrowIndex = isRenameOrCopy ? rawPath.indexOf(" -> ") : -1;
  const target = arrowIndex >= 0 ? rawPath.slice(arrowIndex + 4) : rawPath;
  return unquoteGitPath(isRenameOrCopy ? target.trim() : target);
}

function normalizeNumstatPath(rawPath: string): string {
  const braceRename = rawPath.match(/^(.*)\{[^}]*=>\s*([^}]*)\}(.*)$/);
  if (braceRename) {
    return unquoteGitPath(
      `${braceRename[1]}${braceRename[2]}${braceRename[3]}`.replace(/\/+/g, "/").replace(/^\/+/, ""),
    );
  }
  const arrowIndex = rawPath.indexOf(" => ");
  if (arrowIndex >= 0) {
    return unquoteGitPath(rawPath.slice(arrowIndex + 4).trim());
  }
  return unquoteGitPath(rawPath.trim());
}

function classifyStatusState(indexCode: string, worktreeCode: string): GitFileState {
  if (indexCode === "?" && worktreeCode === "?") return "?";
  if (
    indexCode === "U" ||
    worktreeCode === "U" ||
    (indexCode === "A" && worktreeCode === "A") ||
    (indexCode === "D" && worktreeCode === "D")
  ) {
    return "U";
  }

  const hasStaged = indexCode !== " " && indexCode !== "?";
  const hasUnstaged = worktreeCode !== " " && worktreeCode !== "?";
  if (hasStaged && hasUnstaged) return "SM";
  if (hasStaged) return "S";
  return "M";
}

function parseBranchHeader(headerLine: string): {
  branch?: string | undefined;
  ahead: number;
  behind: number;
} {
  const body = headerLine.slice(3).trim();
  const bracketMatch = body.match(/\[([^\]]+)\]$/);
  let ahead = 0;
  let behind = 0;
  if (bracketMatch?.[1]) {
    const aheadMatch = bracketMatch[1].match(/ahead (\d+)/);
    const behindMatch = bracketMatch[1].match(/behind (\d+)/);
    if (aheadMatch) ahead = Number(aheadMatch[1]);
    if (behindMatch) behind = Number(behindMatch[1]);
  }

  const refPart = (bracketMatch ? body.slice(0, bracketMatch.index) : body).trim();
  if (refPart.startsWith("No commits yet on ")) {
    return { branch: refPart.slice("No commits yet on ".length).trim() || undefined, ahead, behind };
  }
  if (refPart === "HEAD (no branch)") {
    return { branch: "detached", ahead, behind };
  }

  const dotsIndex = refPart.indexOf("...");
  const branch = (dotsIndex >= 0 ? refPart.slice(0, dotsIndex) : refPart).trim() || undefined;
  return { branch, ahead, behind };
}

export function parseGitStatusPorcelain(output: string): {
  branch?: string | undefined;
  ahead: number;
  behind: number;
  entries: GitStatusEntry[];
} {
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  let branch: string | undefined;
  let ahead = 0;
  let behind = 0;
  const entries: GitStatusEntry[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      const parsed = parseBranchHeader(line);
      branch = parsed.branch;
      ahead = parsed.ahead;
      behind = parsed.behind;
      continue;
    }
    if (line.length < 4) continue;

    const indexCode = line[0] ?? " ";
    const worktreeCode = line[1] ?? " ";
    const isRenameOrCopy = indexCode === "R" || indexCode === "C" || worktreeCode === "R" || worktreeCode === "C";
    const path = normalizeStatusPath(line.slice(3), isRenameOrCopy);
    if (!path) continue;
    entries.push({ path, state: classifyStatusState(indexCode, worktreeCode) });
  }

  return { branch, ahead, behind, entries };
}

export function parseGitNumstat(output: string): GitNumstatEntry[] {
  const entries: GitNumstatEntry[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;

    const [insRaw, delRaw, ...rest] = parts;
    if (insRaw === undefined || delRaw === undefined) continue;
    const path = normalizeNumstatPath(rest.join("\t"));
    if (!path) continue;

    const binary = insRaw === "-" || delRaw === "-";
    const insertions = binary ? 0 : Number.parseInt(insRaw, 10) || 0;
    const deletions = binary ? 0 : Number.parseInt(delRaw, 10) || 0;
    entries.push({ path, insertions, deletions, binary });
  }
  return entries;
}

export function mergeGitDiffs(
  statusEntries: readonly GitStatusEntry[],
  unstagedStats: readonly GitNumstatEntry[],
  stagedStats: readonly GitNumstatEntry[],
): { files: GitFileDiff[]; totalInsertions: number; totalDeletions: number } {
  const statsByPath = new Map<string, { insertions: number; deletions: number; binary: boolean }>();
  for (const stat of [...stagedStats, ...unstagedStats]) {
    const existing = statsByPath.get(stat.path);
    if (existing) {
      existing.insertions += stat.insertions;
      existing.deletions += stat.deletions;
      existing.binary = existing.binary || stat.binary;
    } else {
      statsByPath.set(stat.path, {
        insertions: stat.insertions,
        deletions: stat.deletions,
        binary: stat.binary,
      });
    }
  }

  let totalInsertions = 0;
  let totalDeletions = 0;
  const files: GitFileDiff[] = statusEntries.map((entry) => {
    const stat = statsByPath.get(entry.path);
    const insertions = stat?.insertions ?? 0;
    const deletions = stat?.deletions ?? 0;
    totalInsertions += insertions;
    totalDeletions += deletions;
    return {
      path: entry.path,
      state: entry.state,
      insertions,
      deletions,
      binary: stat?.binary ?? false,
    };
  });

  return { files, totalInsertions, totalDeletions };
}

async function runGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-c", "core.quotepath=false", ...args], {
      cwd,
      timeout: 2000,
      maxBuffer: 1024 * 1024,
    });
    return stdout;
  } catch {
    return undefined;
  }
}

export async function readWorkspaceGitSnapshot(cwd: string): Promise<WorkspaceGitSnapshot> {
  const statusOutput = await runGit(cwd, ["status", "--porcelain=v1", "-b"]);
  if (statusOutput === undefined) return EMPTY_GIT_SNAPSHOT;

  const [unstagedOutput, stagedOutput] = await Promise.all([
    runGit(cwd, ["diff", "--numstat"]),
    runGit(cwd, ["diff", "--cached", "--numstat"]),
  ]);

  const status = parseGitStatusPorcelain(statusOutput);
  const unstaged = unstagedOutput ? parseGitNumstat(unstagedOutput) : [];
  const staged = stagedOutput ? parseGitNumstat(stagedOutput) : [];
  const merged = mergeGitDiffs(status.entries, unstaged, staged);

  return {
    isRepo: true,
    branch: status.branch,
    ahead: status.ahead,
    behind: status.behind,
    files: merged.files,
    totalInsertions: merged.totalInsertions,
    totalDeletions: merged.totalDeletions,
  };
}
