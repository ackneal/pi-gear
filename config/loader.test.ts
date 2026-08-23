import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { loadExtensionConfig } from "./loader.ts";

test("runtime filesystem defaults include writable tmp and read-only Pi skills", async () => {
  const config = await loadExtensionConfig();

  assert.deepEqual(
    config.filesystem.rules.filter((rule) => rule.path === "/tmp/**" || rule.path === join(getAgentDir(), "skills", "**")),
    [
      { path: "/tmp/**", access: "read-write", follow: true },
      { path: join(getAgentDir(), "skills", "**"), access: "read-only", follow: true },
    ],
  );
});
