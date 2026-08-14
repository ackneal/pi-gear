import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AccessPolicy } from "../../config/types.ts";
import { createEffectiveSandboxConfig } from "./config.ts";

const policy: AccessPolicy = {
  filesystem: {
    workspaceDefault: "read-write",
    outsideWorkspaceDefault: "ask",
    rules: [{ path: "/tmp/**", access: "read-write", follow: true }],
  },
  network: { defaultAccess: "ask", rules: [] },
};

test("follow rules add canonical paths to the sandbox boundary", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-gear-config-"));

  try {
    const config = await createEffectiveSandboxConfig(workspace, policy);
    const canonicalTmp = await realpath("/tmp");

    assert.ok(config.filesystem.allowWrite?.includes("/tmp/**"));
    assert.ok(config.filesystem.allowWrite?.includes(`${canonicalTmp}/**`));
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("follow rules map read-only and deny access to sandbox write and read boundaries", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-gear-config-"));
  const writable = "/tmp/pi-gear-follow-write";
  const readonly = "/tmp/pi-gear-follow-readonly";
  const denied = "/tmp/pi-gear-follow-deny";
  const followPolicy: AccessPolicy = {
    filesystem: {
      workspaceDefault: "read-write",
      outsideWorkspaceDefault: "ask",
      rules: [
        { path: `${writable}/**`, access: "read-write", follow: true },
        { path: `${readonly}/**`, access: "read-only", follow: true },
        { path: `${denied}/**`, access: "deny", follow: true },
      ],
    },
    network: { defaultAccess: "ask", rules: [] },
  };

  try {
    await Promise.all([mkdir(writable), mkdir(readonly), mkdir(denied)]);
    const config = await createEffectiveSandboxConfig(workspace, followPolicy);
    const [canonicalWritable, canonicalReadonly, canonicalDenied] = await Promise.all([
      realpath(writable),
      realpath(readonly),
      realpath(denied),
    ]);

    assert.ok(config.filesystem.allowWrite?.includes(`${canonicalWritable}/**`));
    assert.ok(config.filesystem.denyWrite?.includes(`${canonicalReadonly}/**`));
    assert.ok(config.filesystem.denyRead?.includes(`${canonicalDenied}/**`));
    assert.ok(!config.filesystem.allowWrite?.includes(`${canonicalReadonly}/**`));
  } finally {
    await Promise.all([
      rm(writable, { recursive: true, force: true }),
      rm(readonly, { recursive: true, force: true }),
      rm(denied, { recursive: true, force: true }),
    ]);
    await rm(workspace, { recursive: true, force: true });
  }
});
