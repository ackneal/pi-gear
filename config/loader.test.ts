import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { ExtensionConfig } from "./types.ts";

const loadFrom = async (agentDir: string): Promise<ExtensionConfig> => {
  const loaderUrl = new URL("./loader.ts", import.meta.url).href;
  const script = `import { loadExtensionConfig } from ${JSON.stringify(loaderUrl)}; console.log(JSON.stringify(await loadExtensionConfig()));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
  );
  return JSON.parse(stdout) as ExtensionConfig;
};

test("runtime filesystem defaults include explicit temp roots and read-only Pi skills", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gear-agent-dir-"));

  try {
    const config = await loadFrom(agentDir);
    const defaultPaths = new Set(["/tmp", "/private/tmp", join(agentDir, "skills")]);

    assert.deepEqual(
      config.filesystem.rules.filter((rule) => defaultPaths.has(rule.path)),
      [
        { path: "/tmp", access: "read-write" },
        { path: "/private/tmp", access: "read-write" },
        { path: join(agentDir, "skills"), access: "read-only", follow: true },
      ],
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("global config takes priority over the bundled default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gear-agent-dir-"));
  const configDir = join(agentDir, "pi-gear");
  const globalConfig = {
    version: 1,
    filesystem: { rules: [] },
    sandbox: { network: { rules: [{ host: "global.example", access: "allow" }] } },
  };

  try {
    await mkdir(configDir);
    await writeFile(join(configDir, "config.json"), JSON.stringify(globalConfig));
    const loaded = await loadFrom(agentDir);

    assert.deepEqual(loaded.sandbox.network.rules, globalConfig.sandbox.network.rules);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
