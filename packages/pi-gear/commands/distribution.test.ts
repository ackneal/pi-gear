import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Pi installs Git checkouts with npm, which cannot parse workspace: dependencies.
test("distribution manifests link Rostrix without a package-manager-specific protocol", async () => {
  const root = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8"));
  const gear = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const rostrix = JSON.parse(await readFile(new URL("../../pi-rostrix/package.json", import.meta.url), "utf8"));

  assert.deepEqual(root.workspaces, ["packages/*"]);
  assert.deepEqual(root.pi.extensions, ["./packages/pi-gear/index.ts"]);
  assert.equal(gear.dependencies[rostrix.name], rostrix.version);
  for (const manifest of [root, gear, rostrix]) {
    for (const dependency of Object.values(manifest.dependencies ?? {})) {
      assert.doesNotMatch(String(dependency), /^workspace:/);
    }
  }
});
