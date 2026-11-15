import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  mergeGitDiffs,
  parseGitNumstat,
  parseGitStatusPorcelain,
  readWorkspaceGitSnapshot,
} from "./git-status.ts";

test("parseGitStatusPorcelain parses branch tracking and file states", () => {
  const cases = [
    {
      name: "branch with ahead/behind and mixed staged/unstaged/untracked",
      input: [
        "## feat/sidebar...origin/feat/sidebar [ahead 2, behind 1]",
        "M  src/staged.ts",
        " M src/unstaged.ts",
        "MM src/both.ts",
        "?? src/new.ts",
        "UU src/conflict.ts",
        "R  old.ts -> new.ts",
      ].join("\n"),
      expected: {
        branch: "feat/sidebar",
        ahead: 2,
        behind: 1,
        entries: [
          { path: "src/staged.ts", state: "S" },
          { path: "src/unstaged.ts", state: "M" },
          { path: "src/both.ts", state: "SM" },
          { path: "src/new.ts", state: "?" },
          { path: "src/conflict.ts", state: "U" },
          { path: "new.ts", state: "S" },
        ],
      },
    },
    {
      name: "initial repo with no commits yet",
      input: "## No commits yet on main\n?? README.md\n",
      expected: {
        branch: "main",
        ahead: 0,
        behind: 0,
        entries: [{ path: "README.md", state: "?" }],
      },
    },
    {
      name: "detached HEAD",
      input: "## HEAD (no branch)\n",
      expected: {
        branch: "detached",
        ahead: 0,
        behind: 0,
        entries: [],
      },
    },
  ];

  for (const row of cases) {
    assert.deepEqual(parseGitStatusPorcelain(row.input), row.expected, row.name);
  }
});

test("parseGitNumstat parses text, binary, and brace rename lines", () => {
  const output = [
    "12\t3\tsrc/ui.ts",
    "-\t-\tassets/logo.png",
    "4\t1\tsrc/{old => new}/index.ts",
    "2\t0\t{sub => }/root.ts",
  ].join("\n");

  assert.deepEqual(parseGitNumstat(output), [
    { path: "src/ui.ts", insertions: 12, deletions: 3, binary: false },
    { path: "assets/logo.png", insertions: 0, deletions: 0, binary: true },
    { path: "src/new/index.ts", insertions: 4, deletions: 1, binary: false },
    { path: "root.ts", insertions: 2, deletions: 0, binary: false },
  ]);
});

test("mergeGitDiffs sums staged and unstaged line counts per file", () => {
  const status = [
    { path: "src/both.ts", state: "SM" as const },
    { path: "src/new.ts", state: "?" as const },
  ];
  const unstaged = [{ path: "src/both.ts", insertions: 5, deletions: 2, binary: false }];
  const staged = [{ path: "src/both.ts", insertions: 10, deletions: 1, binary: false }];

  assert.deepEqual(mergeGitDiffs(status, unstaged, staged), {
    files: [
      { path: "src/both.ts", state: "SM", insertions: 15, deletions: 3, binary: false },
      { path: "src/new.ts", state: "?", insertions: 0, deletions: 0, binary: false },
    ],
    totalInsertions: 15,
    totalDeletions: 3,
  });
});

test("readWorkspaceGitSnapshot reads a real temporary git repo and handles non-repo", async () => {
  const nonRepoDir = mkdtempSync(join(tmpdir(), "pi-gear-nonrepo-"));
  const repoDir = mkdtempSync(join(tmpdir(), "pi-gear-repo-"));
  try {
    const nonRepo = await readWorkspaceGitSnapshot(nonRepoDir);
    assert.equal(nonRepo.isRepo, false);

    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: repoDir });
    writeFileSync(join(repoDir, "a.txt"), "line1\nline2\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir });

    writeFileSync(join(repoDir, "a.txt"), "line1\nline2\nline3\n");
    execFileSync("git", ["add", "a.txt"], { cwd: repoDir });
    writeFileSync(join(repoDir, "a.txt"), "line1\nline2\nline3\nline4\n");
    writeFileSync(join(repoDir, "b.txt"), "new\n");

    const snapshot = await readWorkspaceGitSnapshot(repoDir);
    assert.equal(snapshot.isRepo, true);
    assert.equal(snapshot.branch, "main");
    assert.deepEqual(snapshot.files, [
      { path: "a.txt", state: "SM", insertions: 2, deletions: 0, binary: false },
      { path: "b.txt", state: "?", insertions: 0, deletions: 0, binary: false },
    ]);
    assert.equal(snapshot.totalInsertions, 2);
    assert.equal(snapshot.totalDeletions, 0);
  } finally {
    rmSync(nonRepoDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
  }
});
