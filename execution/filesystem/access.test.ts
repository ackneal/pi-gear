import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesystemAccess } from "./access.ts";

const policy = (path: string, deny: boolean) => ({
  version: 1 as const,
  filesystem: { rules: deny ? [{ path, access: "deny" as const }] : [] },
  sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
});

test("filesystem access reloads policy and recovers from loader failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-access-policy-"));
  const workspace = join(root, "workspace");
  const source = join(workspace, "source.ts");

  try {
    await mkdir(workspace);
    await writeFile(source, "test");

    let loads = 0;
    const access = new FilesystemAccess(workspace, {
      loadConfig: async () => {
        loads++;
        if (loads === 1) throw new Error("temporary failure");
        return policy(source, loads === 2);
      },
    });

    await assert.rejects(access.authorize(source, "read"), /temporary failure/);
    assert.equal((await access.authorize(source, "read")).decision, "deny");
    assert.equal((await access.authorize(source, "read")).decision, "allow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
