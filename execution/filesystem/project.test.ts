import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { detectProjectRoot } from "./project.ts";

test("detectProjectRoot identifies git and project markers within safe boundaries", async (t) => {
  const root = join(tmpdir(), `pi-gear-project-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const home = join(root, "home");

  const gitRepo = join(home, "dev", "git-repo");
  const gitSubdir = join(gitRepo, "src", "nested");
  const gitMonorepoPackage = join(gitRepo, "packages", "pkg-a");

  const nonGitProject = join(home, "standalone-cargo");
  const nonGitSubdir = join(nonGitProject, "src");

  const bareDirectory = join(home, "documents", "notes");
  const homeFile = join(home, "root.txt");

  await mkdir(gitSubdir, { recursive: true });
  await mkdir(gitMonorepoPackage, { recursive: true });
  await mkdir(join(gitRepo, ".git"), { recursive: true });
  await writeFile(join(gitMonorepoPackage, "package.json"), "{}");
  await writeFile(join(gitSubdir, "index.ts"), "");

  await mkdir(nonGitSubdir, { recursive: true });
  await writeFile(join(nonGitProject, "Cargo.toml"), "");
  await writeFile(join(nonGitSubdir, "main.rs"), "");

  await mkdir(bareDirectory, { recursive: true });
  await writeFile(join(bareDirectory, "note.txt"), "");
  await writeFile(homeFile, "");

  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const cases = [
    {
      name: "returns git root for deeply nested file in git repository",
      target: join(gitSubdir, "index.ts"),
      expected: gitRepo,
    },
    {
      name: "prefers enclosing git root over nested package.json in monorepo",
      target: join(gitMonorepoPackage, "package.json"),
      expected: gitRepo,
    },
    {
      name: "returns project marker root when no git repository exists",
      target: join(nonGitSubdir, "main.rs"),
      expected: nonGitProject,
    },
    {
      name: "returns undefined for directory without project markers",
      target: join(bareDirectory, "note.txt"),
      expected: undefined,
    },
    {
      name: "stops at home boundary without returning home",
      target: homeFile,
      expected: undefined,
    },
    {
      name: "respects custom boundary",
      target: join(gitSubdir, "index.ts"),
      options: { boundary: gitRepo },
      expected: undefined,
    },
  ];

  for (const { name, target, options, expected } of cases) {
    const actual = await detectProjectRoot(target, { home, ...options });
    assert.equal(actual, expected, name);
  }
});
