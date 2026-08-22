import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AccessPolicy } from "../../config/types.ts";
import { createEffectiveSandboxConfig, createSandboxConfig, normalizeTempAlias, resolveRuntimeTempDir } from "./config.ts";

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

    // The /tmp alias is canonicalized to its macOS target before policy building.
    assert.ok(config.filesystem.allowWrite?.includes(`${canonicalTmp}/**`));
    assert.ok(!config.filesystem.allowWrite?.includes("/tmp/**"));
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

const barePolicy: AccessPolicy = {
  filesystem: { workspaceDefault: "read-write", outsideWorkspaceDefault: "ask", rules: [] },
  network: { defaultAccess: "ask", rules: [] },
};

const tmpOptInPolicy: AccessPolicy = {
  ...barePolicy,
  filesystem: { ...barePolicy.filesystem, rules: [{ path: "/tmp/**", access: "read-write", follow: true }] },
};

test("TMPDIR becomes a runtime writable root", async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), "pi-gear-tmpdir-"));
  try {
    const { path } = await resolveRuntimeTempDir({ TMPDIR: tempRoot });
    assert.equal(path, await realpath(tempRoot));

    const workspace = join(tempRoot, "workspace");
    const config = createSandboxConfig(workspace, barePolicy, { tempDir: path });

    // A bare directory entry grants the whole subtree, mirroring how the workspace root works.
    assert.deepEqual(config.filesystem.allowWrite, [workspace, path]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("only the current process TMPDIR root is writable among its siblings", async () => {
  const parent = await mkdtemp(join(tmpdir(), "pi-gear-siblings-"));
  const tempRoot = join(parent, "current");
  const sibling = join(parent, "other");
  await Promise.all([mkdir(tempRoot), mkdir(sibling)]);
  try {
    const { path } = await resolveRuntimeTempDir({ TMPDIR: tempRoot });
    assert.ok(path);
    const config = createSandboxConfig("/workspace", barePolicy, { tempDir: path });

    // Only the exact current-process temp root appears; sibling temp roots stay out.
    const canonicalParent = await realpath(parent);
    const parentEntries = config.filesystem.allowWrite?.filter((entry) => entry.startsWith(canonicalParent)) ?? [];
    assert.deepEqual(parentEntries, [path]);
    assert.ok(!config.filesystem.allowWrite?.includes(sibling));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("/tmp is not writable unless configured", () => {
  const config = createSandboxConfig("/workspace", barePolicy);
  assert.ok(!config.filesystem.allowWrite?.includes("/tmp"));
  assert.ok(!config.filesystem.allowWrite?.includes("/private/tmp"));
});

test("configured /tmp access canonicalizes to /private/tmp", () => {
  const config = createSandboxConfig("/workspace", tmpOptInPolicy);
  assert.ok(config.filesystem.allowWrite?.includes("/private/tmp/**"));
  assert.ok(!config.filesystem.allowWrite?.includes("/tmp/**"));
});

test("canonical /private/tmp selectors deduplicate against configured /tmp", () => {
  const privateTmpPolicy: AccessPolicy = {
    ...barePolicy,
    filesystem: {
      ...barePolicy.filesystem,
      rules: [{ path: "/private/tmp/**", access: "read-write" }],
    },
  };
  const config = createSandboxConfig("/workspace", privateTmpPolicy);
  assert.ok(config.filesystem.allowWrite?.includes("/private/tmp/**"));
  assert.equal(config.filesystem.allowWrite?.filter((entry) => entry === "/private/tmp/**").length, 1);
});

test("TMPDIR resolution skips invalid values with a warning", async () => {
  const notADirectory = await mkdtemp(join(tmpdir(), "pi-gear-invalid-"));
  const filePath = join(notADirectory, "file.txt");
  await writeFile(filePath, "x");

  const cases: readonly {
    readonly name: string;
    readonly value?: string;
    readonly expectedWarning?: RegExp;
  }[] = [
    { name: "unset" },
    { name: "blank behaves like unset", value: "" },
    { name: "whitespace-only behaves like unset", value: "   " },
    { name: "relative path", value: "relative/tmp", expectedWarning: /absolute/ },
    { name: "missing directory", value: join(notADirectory, "does-not-exist"), expectedWarning: /.+/ },
    { name: "not a directory", value: filePath, expectedWarning: /not a directory/ },
  ];

  try {
    for (const { name, value, expectedWarning } of cases) {
      const result = await resolveRuntimeTempDir(value === undefined ? {} : { TMPDIR: value });
      assert.equal(result.path, undefined, name);
      if (expectedWarning !== undefined) assert.match(result.warning ?? "", expectedWarning, name);
      else assert.equal(result.warning, undefined, name);
    }
  } finally {
    await rm(notADirectory, { recursive: true, force: true });
  }
});

test("TMPDIR /tmp alias normalizes to /private/tmp on darwin only", async () => {
  const aliasCases: readonly (readonly [string, NodeJS.Platform, string])[] = [
    ["/tmp", "darwin", "/private/tmp"],
    ["/tmp/nested", "darwin", "/private/tmp/nested"],
    ["/private/tmp", "darwin", "/private/tmp"],
    ["/workspace", "darwin", "/workspace"],
    ["/tmp", "linux", "/tmp"],
  ];

  for (const [input, platform, expected] of aliasCases) {
    assert.equal(normalizeTempAlias(input, platform), expected, `${input} on ${platform}`);
  }

  // A missing aliased path must surface the canonical spelling in its warning.
  const aliased = await resolveRuntimeTempDir({ TMPDIR: "/tmp/pi-gear-alias" }, "darwin");
  assert.equal(aliased.path, undefined);
  assert.match(aliased.warning ?? "", /private\/tmp/);
});
