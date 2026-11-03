import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createSandboxedBashOperations } from "./spawn.ts";

test("customConfigFor allows writing to dynamically approved directory and restricts when cleared", {
  skip: process.platform !== "darwin",
}, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-gear-spawn-ws-"));
  const outsideDir = await mkdtemp(join(tmpdir(), "pi-gear-spawn-outside-"));

  let customConfig: SandboxRuntimeConfig = {
    filesystem: { allowRead: [], denyRead: [], allowWrite: [workspace], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  };

  const operations = createSandboxedBashOperations({
    isAvailable: () => true,
    unavailableReason: () => "unused",
    onCleanupFailure: () => undefined,
    onExecutionPrevented: () => undefined,
    customConfigFor: async () => customConfig,
  });

  try {
    // 1. Without outsideDir in allowWrite, customConfigFor reflects restricted write
    assert.deepEqual(customConfig.filesystem.allowWrite, [workspace]);

    // 2. Dynamically add outsideDir to allowWrite for the next command
    customConfig = {
      ...customConfig,
      filesystem: {
        ...customConfig.filesystem,
        allowWrite: [workspace, outsideDir],
      },
    };
    assert.ok(customConfig.filesystem.allowWrite.includes(outsideDir));

    // 3. Clear session approval: next command loses outsideDir
    customConfig = {
      ...customConfig,
      filesystem: {
        ...customConfig.filesystem,
        allowWrite: [workspace],
      },
    };
    assert.ok(!customConfig.filesystem.allowWrite.includes(outsideDir));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  }
});

test("unavailable sandbox prevents host command execution", async () => {
  const prevented: string[] = [];
  const operations = createSandboxedBashOperations({
    isAvailable: () => false,
    unavailableReason: () => "test unavailable",
    onCleanupFailure: () => assert.fail("cleanup must not run"),
    onExecutionPrevented: (command) => prevented.push(command),
    customConfigFor: async () => assert.fail("sandbox config must not be requested"),
  });
  await assert.rejects(
    operations.exec("printf host-execution", process.cwd(), { onData: () => undefined }),
    /Sandbox unavailable: test unavailable/,
  );
  assert.deepEqual(prevented, ["printf host-execution"]);
});

test("sandbox spawn abort and timeout terminate commands and clean up", {
  concurrency: false,
  skip: process.platform !== "darwin",
}, async () => {
  await assert.doesNotReject(access("/usr/bin/sandbox-exec"));
  const dependencies = await SandboxManager.checkDependenciesAsync();
  assert.deepEqual(dependencies.errors, []);
  const workspace = await mkdtemp(join(tmpdir(), "pi-gear-spawn-"));
  const config: SandboxRuntimeConfig = {
    filesystem: { allowRead: [], denyRead: [], allowWrite: [workspace], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  };
  const operations = createSandboxedBashOperations({
    isAvailable: () => true,
    unavailableReason: () => "unused",
    onCleanupFailure: () => assert.fail("sandbox cleanup failed"),
    onExecutionPrevented: () => assert.fail("execution unexpectedly prevented"),
    customConfigFor: async () => config,
  });
  try {
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
    await SandboxManager.initialize(config, async () => false);
    const controller = new AbortController();
    const aborted = operations.exec("sleep 30", workspace, { signal: controller.signal, onData: () => undefined });
    setTimeout(() => controller.abort(), 25);
    await assert.rejects(aborted, /Sandbox aborted/);
    await assert.rejects(
      operations.exec("sleep 30", workspace, { timeout: 0.025, onData: () => undefined }),
      /Sandbox timed out after 0.025 seconds/,
    );
  } finally {
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
    await rm(workspace, { recursive: true, force: true });
  }
});
