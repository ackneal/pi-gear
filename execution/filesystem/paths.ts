import { access, lstat, readlink, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export interface CanonicalWorkspace {
  readonly cwd: string;
  readonly canonicalRoot: string;
}

export interface ResolvedAccessTarget {
  readonly path: string;
  readonly canonicalPath: string;
  readonly withinWorkspace: boolean;
}

const isMissingPathError = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

const unicodeSpaces = /[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;

/** Mirrors Pi's public path spelling normalization without depending on private internals. */
export const normalizeToolPath = (path: string, cwd: string): string => {
  let normalized = path.replace(unicodeSpaces, " ");
  if (normalized.startsWith("@")) normalized = normalized.slice(1);
  if (normalized === "~" || normalized.startsWith("~/")) {
    normalized = resolve(homedir(), normalized.slice(2));
  }
  if (normalized.startsWith("file://")) normalized = fileURLToPath(normalized);
  return resolve(cwd, normalized);
};

/** Produces Pi 0.84.3's ordered, deduplicated read fallback spellings. */
export const readFallbackCandidates = (path: string): readonly string[] => {
  const nfd = path.normalize("NFD");
  return [...new Set([
    path,
    path.replace(/ (AM|PM)\./gi, "\u202f$1."),
    nfd,
    path.replaceAll("'", "’"),
    nfd.replaceAll("'", "’"),
  ])];
};

/** Selects the existing fallback Pi can open, failing closed on probe errors. */
export const selectReadPath = async (path: string): Promise<string> => {
  for (const candidate of readFallbackCandidates(path)) {
    try {
      await access(candidate);
      return candidate;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
    }
  }
  return path;
};

const canonicalizeResolvedPath = async (
  input: string,
  cwd: string,
  seenSymlinks = new Set<string>(),
): Promise<string> => {
  let candidate = resolve(cwd, input);
  const missingSegments: string[] = [];

  for (; ;) {
    try {
      return resolve(await realpath(candidate), ...missingSegments);
    } catch (error: unknown) {
      if (!isMissingPathError(error)) throw error;

      // realpath() fails for a dangling symlink, but lstat() still exposes the
      // link. Resolve it before appending missing descendants so writes cannot
      // follow an untrusted link outside the workspace after authorization.
      try {
        const stats = await lstat(candidate);
        if (stats.isSymbolicLink()) {
          if (seenSymlinks.has(candidate)) throw new Error(`Symlink cycle at ${candidate}`);
          const target = resolve(dirname(candidate), await readlink(candidate));
          const nextSeen = new Set(seenSymlinks);
          nextSeen.add(candidate);
          return canonicalizeResolvedPath(resolve(target, ...missingSegments), cwd, nextSeen);
        }
      } catch (lstatError: unknown) {
        if (!isMissingPathError(lstatError)) throw lstatError;
      }

      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      missingSegments.unshift(basename(candidate));
      candidate = parent;
    }
  }
};

/** Canonicalizes the root before it is used as a workspace boundary. */
export const canonicalizeWorkspace = async (cwd: string): Promise<CanonicalWorkspace> => ({
  cwd: resolve(process.cwd(), cwd),
  canonicalRoot: await canonicalizeResolvedPath(resolve(process.cwd(), cwd), process.cwd()),
});

export const isWithinWorkspace = (workspace: CanonicalWorkspace, candidatePath: string): boolean => {
  const pathFromRoot = relative(workspace.canonicalRoot, candidatePath);
  return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
};

/** Resolves the exact tool spelling that will be authorized and subsequently opened. */
export const resolveAccessTarget = async (path: string, workspace: CanonicalWorkspace): Promise<ResolvedAccessTarget> => {
  const targetPath = resolve(workspace.cwd, path);
  const canonicalPath = await canonicalizeResolvedPath(targetPath, workspace.cwd);
  return { path: targetPath, canonicalPath, withinWorkspace: isWithinWorkspace(workspace, canonicalPath) };
};
