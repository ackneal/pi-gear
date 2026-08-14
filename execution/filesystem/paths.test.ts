import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalizeWorkspace, normalizeToolPath, resolveAccessTarget } from "./paths.ts";

test("workspace resolution retains lexical paths and rejects canonical symlink escapes, including nonexistent descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-workspace-"));
  const workspacePath = join(root, "workspace");
  const outsidePath = join(root, "outside");
  try {
    await Promise.all([mkdir(workspacePath), mkdir(outsidePath)]);
    await symlink(outsidePath, join(workspacePath, "escape"));
    const workspace = await canonicalizeWorkspace(workspacePath);
    const lexical = normalizeToolPath("escape/new/file.txt", workspace.cwd);
    const target = await resolveAccessTarget(lexical, workspace);
    assert.equal(target.path, join(workspacePath, "escape/new/file.txt"));
    assert.equal(target.canonicalPath, join(await realpath(outsidePath), "new/file.txt"));
    assert.equal(target.withinWorkspace, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace resolution rejects dangling symlinks before a write can follow them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-workspace-"));
  const workspacePath = join(root, "workspace");
  const outsidePath = join(root, "outside");
  try {
    await Promise.all([mkdir(workspacePath), mkdir(outsidePath)]);
    await symlink(join(outsidePath, "not-created-yet"), join(workspacePath, "escape"));
    const workspace = await canonicalizeWorkspace(workspacePath);
    const target = await resolveAccessTarget(normalizeToolPath("escape/new.txt", workspace.cwd), workspace);
    assert.equal(target.canonicalPath, join(await realpath(outsidePath), "not-created-yet", "new.txt"));
    assert.equal(target.withinWorkspace, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
