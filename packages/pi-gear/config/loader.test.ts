import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

test("global config in ~/.pi/agent/gear takes priority over the bundled default", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gear-agent-dir-"));
  const configDir = join(agentDir, "gear");
  const globalConfig = {
    version: 1,
    filesystem: { rules: [] },
    sandbox: { network: { rules: [{ host: "global.example", access: "allow" }] } },
  };

  try {
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, "config.json"), JSON.stringify(globalConfig));
    const loaded = await loadFrom(agentDir);

    assert.deepEqual(loaded.sandbox.network.rules, globalConfig.sandbox.network.rules);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

const appendTo = async (agentDir: string, host: string): Promise<ExtensionConfig> => {
  const loaderUrl = new URL("./loader.ts", import.meta.url).href;
  const script = `import { appendAllowedNetworkHost } from ${JSON.stringify(loaderUrl)}; console.log(JSON.stringify(await appendAllowedNetworkHost(${JSON.stringify(host)})));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
  );
  return JSON.parse(stdout) as ExtensionConfig;
};

const appendFsRuleTo = async (agentDir: string, rule: { path: string; access: string }): Promise<ExtensionConfig> => {
  const loaderUrl = new URL("./loader.ts", import.meta.url).href;
  const script = `import { appendAllowedFilesystemRule } from ${JSON.stringify(loaderUrl)}; console.log(JSON.stringify(await appendAllowedFilesystemRule(${JSON.stringify(rule)})));`;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "--eval", script],
    { env: { ...process.env, PI_CODING_AGENT_DIR: agentDir } },
  );
  return JSON.parse(stdout) as ExtensionConfig;
};

test("appendAllowedFilesystemRule normalizes path, avoids duplicates, and upgrades access", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gear-agent-dir-"));

  try {
    const updated = await appendFsRuleTo(agentDir, { path: "~/Developer/other-project/**", access: "read-only" });
    const rule = updated.filesystem.rules.find((r) => r.path === "~/Developer/other-project/**");
    assert.equal(rule?.access, "read-only");

    const upgraded = await appendFsRuleTo(agentDir, { path: "~/Developer/other-project/**", access: "read-write" });
    const matching = upgraded.filesystem.rules.filter((r) => r.path === "~/Developer/other-project/**");
    assert.equal(matching.length, 1);
    assert.equal(matching[0]?.access, "read-write");

    const retained = await appendFsRuleTo(agentDir, { path: "~/Developer/other-project/**", access: "read-only" });
    const finalMatching = retained.filesystem.rules.filter((r) => r.path === "~/Developer/other-project/**");
    assert.equal(finalMatching.length, 1);
    assert.equal(finalMatching[0]?.access, "read-write");
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("appendAllowedNetworkHost normalizes host and updates config idempotently", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gear-agent-dir-"));

  try {
    const updated = await appendTo(agentDir, "DL.Google.COM");
    assert.ok(updated.sandbox.network.rules.some((rule) => rule.host === "dl.google.com" && rule.access === "allow"));

    const reloaded = await appendTo(agentDir, "dl.google.com");
    const matching = reloaded.sandbox.network.rules.filter((rule) => rule.host === "dl.google.com");
    assert.equal(matching.length, 1);
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});

test("appendAllowedFilesystemRule rejects invalid rule without modifying file on disk", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-gear-agent-dir-"));

  try {
    const configPath = join(agentDir, "gear", "config.json");
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ version: 1, filesystem: { rules: [] } }), "utf8");

    await assert.rejects(async () => {
      await appendFsRuleTo(agentDir, { path: "/some/path", access: "invalid-access" });
    });

    const onDisk = JSON.parse(await readFile(configPath, "utf8"));
    assert.deepEqual(onDisk, { version: 1, filesystem: { rules: [] } });
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
});
