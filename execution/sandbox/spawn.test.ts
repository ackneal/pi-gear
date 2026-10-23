import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { createSandboxedBashOperations } from "./spawn.ts";

for (const scenario of [
  { name: "unavailable", available: false, reason: "Sandbox unavailable: test unavailable" },
  { name: "setup failure", available: true, reason: "Sandbox preparation failed: test setup failure" },
]) {
  test(`${scenario.name} prevents execution and gives conditional approval guidance`, async () => {
    const prevented: Array<[string, string]> = [];
    const operations = createSandboxedBashOperations({
      isAvailable: () => scenario.available,
      unavailableReason: () => "test unavailable",
      onCleanupFailure: () => assert.fail("cleanup must not run"),
      onExecutionPrevented: (command, reason) => prevented.push([command, reason]),
      customConfigFor: async () => { throw new Error("test setup failure"); },
    });

    await assert.rejects(
      operations.exec("printf host-execution", process.cwd(), { onData: () => assert.fail("must not execute") }),
      { message: `Sandboxed execution did not run: ${scenario.reason}. For sandbox availability or setup failures only, host execution approval may be requested via request_command. Never bypass user denial or policy restrictions.` },
    );
    assert.deepEqual(prevented, [["printf host-execution", scenario.reason]]);
  });
}

for (const violation of [false, true]) {
  test(`sandbox output ${violation ? "respects violations without escalation" : "does not invent violations"}`, async (t) => {
    t.mock.method(SandboxManager, "wrapWithSandbox", async () => "printf test-output");
    t.mock.method(SandboxManager, "annotateStderrWithSandboxFailures", (_id: string, stderr: string) =>
      violation ? `${stderr}restricted` : stderr);
    t.mock.method(SandboxManager, "cleanupAfterCommand", () => undefined);
    const output: string[] = [];
    const operations = createSandboxedBashOperations({
      isAvailable: () => true,
      unavailableReason: () => "unused",
      onCleanupFailure: () => assert.fail("cleanup failed"),
      onExecutionPrevented: () => assert.fail("execution prevented"),
      customConfigFor: async () => ({
        filesystem: { allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] },
        network: { allowedDomains: [], deniedDomains: [] },
      }),
    });

    assert.deepEqual(await operations.exec("printf test-output", process.cwd(), {
      onData: (data) => output.push(data.toString()),
    }), { exitCode: 0 });
    assert.equal(output.join(""), "test-output" + (violation
      ? "\nSandbox violation: restricted\nNo unsandboxed fallback occurred. Respect sandbox restrictions and user denials; do not escalate to host execution.\n"
      : ""));
  });
}

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
