import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AccessPolicy, FilesystemRule } from "../../config/types.ts";
import { createEffectiveSandboxConfig } from "./config.ts";

const policyFor = (rule: FilesystemRule): AccessPolicy => ({
  filesystem: { rules: [rule] },
  sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
});

for (const access of ["read-write", "read-only", "deny"] as const) {
  for (const missing of ["alias removed after approval", "target removed after approval", "initially dangling target"] as const) {
    for (const selector of ["exact", "wildcard"] as const) {
      test(`follow ${access}, ${selector}: ${missing}`, async () => {
        const temporary = await mkdtemp(join(tmpdir(), "pi-gear-follow-missing-"));
        try {
          // tmpdir itself can be an alias on macOS; only the fixture link should need following.
          const root = await realpath(temporary);
          const workspace = join(root, "workspace");
          const outside = join(root, "outside");
          const target = join(outside, "target");
          const alias = join(root, "alias");
          await Promise.all([mkdir(workspace), mkdir(outside)]);
          if (missing !== "initially dangling target") {
            await mkdir(target);
            await writeFile(join(target, "file.txt"), "approved");
          }
          await symlink(target, alias);

          const suffix = selector === "exact" ? "/file.txt" : "/**";
          const lexical = `${alias}${suffix}`;
          const canonical = `${target}${suffix}`;
          const policy = policyFor({ path: lexical, access, follow: true });
          const assertBoundary = (config: Awaited<ReturnType<typeof createEffectiveSandboxConfig>>, mapped: string): void => {
            const paths = [...new Set([lexical, mapped])];
            assert.deepEqual(config.filesystem.allowWrite, access === "read-write" ? [workspace, ...paths] : [workspace]);
            assert.deepEqual(config.filesystem.denyRead, access === "deny" ? paths : []);
            // Ignore only the runtime's unrelated home-log write restrictions.
            assert.deepEqual(config.filesystem.denyWrite?.filter((path) => path.startsWith(`${root}/`)), access === "read-write" ? [] : paths);
          };

          if (missing !== "initially dangling target") {
            assertBoundary(await createEffectiveSandboxConfig(workspace, policy), canonical);
            await rm(missing === "alias removed after approval" ? alias : target, { recursive: true });
          }

          const config = await createEffectiveSandboxConfig(workspace, policy);

          // Once the alias itself is gone its old destination is unknowable; retain its lexical boundary.
          assertBoundary(config, missing === "alias removed after approval" ? lexical : canonical);
        } finally {
          await rm(temporary, { recursive: true, force: true });
        }
      });
    }
  }
}

for (const selector of ["exact", "wildcard"] as const) {
  test(`follow ${selector}: symlink cycles still reject`, async () => {
    const temporary = await mkdtemp(join(tmpdir(), "pi-gear-follow-cycle-"));
    try {
      const root = await realpath(temporary);
      const workspace = join(root, "workspace");
      const first = join(root, "first");
      const second = join(root, "second");
      await mkdir(workspace);
      await symlink(second, first);
      await symlink(first, second);
      const path = selector === "exact" ? first : `${first}/**`;
      const policy = policyFor({ path, access: "read-write", follow: true });

      await assert.rejects(createEffectiveSandboxConfig(workspace, policy), (error: unknown) =>
        error instanceof Error && ("code" in error && error.code === "ELOOP" || /symlink cycle/i.test(error.message)));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });
}
