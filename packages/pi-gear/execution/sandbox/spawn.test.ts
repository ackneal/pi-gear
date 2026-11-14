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
    await assert.rejects(aborted, /Command cancelled/);
    await assert.rejects(
      operations.exec("sleep 30", workspace, { timeout: 0.025, onData: () => undefined }),
      /Sandbox timed out after 0.025 seconds/,
    );
  } finally {
    if (SandboxManager.isSandboxingEnabled()) await SandboxManager.reset();
    await rm(workspace, { recursive: true, force: true });
  }
});

test("caller cancellation is distinguished from sandbox errors across wrapping and execution", async () => {
  const baseConfig: SandboxRuntimeConfig = {
    filesystem: { allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  };
  const cases = [
    {
      name: "pre-aborted signal before wrapping",
      command: "echo hi",
      preAbort: true,
      wrap: async (command: string) => command,
      expectedConfigCalls: 0,
      expectedWrapCalls: 0,
      expectedCleanupCalls: 0,
      expectedOutput: "",
      expectedError: /^Command cancelled$/,
      expectPrevented: false,
    },
    {
      name: "aborted during sandbox wrapping when wrap throws",
      command: "echo hi",
      wrap: async (_command: string, controller: AbortController) => {
        controller.abort();
        throw new Error("wrap interrupted");
      },
      expectedConfigCalls: 1,
      expectedWrapCalls: 1,
      expectedCleanupCalls: 0,
      expectedOutput: "",
      expectedError: /^Command cancelled$/,
      expectPrevented: false,
    },
    {
      name: "aborted during sandbox wrapping when wrap resolves",
      command: "printf should-not-run",
      wrap: async (command: string, controller: AbortController) => {
        controller.abort();
        return command;
      },
      expectedConfigCalls: 1,
      expectedWrapCalls: 1,
      expectedCleanupCalls: 0,
      expectedOutput: "",
      expectedError: /^Command cancelled$/,
      expectPrevented: false,
    },
    {
      name: "aborted after customConfigFor before wrapping",
      command: "echo hi",
      abortInConfig: true,
      wrap: async (command: string) => command,
      expectedConfigCalls: 1,
      expectedWrapCalls: 0,
      expectedCleanupCalls: 0,
      expectedOutput: "",
      expectedError: /^Command cancelled$/,
      expectPrevented: false,
    },
    {
      name: "genuine wrapping failure reports sandbox preparation error",
      command: "echo hi",
      wrap: async () => { throw new Error("missing seatbelt profile"); },
      expectedConfigCalls: 1,
      expectedWrapCalls: 1,
      expectedCleanupCalls: 0,
      expectedOutput: "",
      expectedError: /Sandbox preparation failed: missing seatbelt profile/,
      expectPrevented: true,
    },
    {
      name: "aborted running command reports Command cancelled",
      command: "sleep 30",
      abortAfterMs: 25,
      wrap: async (command: string) => command,
      expectedConfigCalls: 1,
      expectedWrapCalls: 1,
      expectedCleanupCalls: 1,
      expectedOutput: "",
      expectedError: /^Command cancelled$/,
      expectPrevented: false,
    },
    {
      name: "timed out running command reports sandbox timeout",
      command: "sleep 30",
      timeout: 0.025,
      wrap: async (command: string) => command,
      expectedConfigCalls: 1,
      expectedWrapCalls: 1,
      expectedCleanupCalls: 1,
      expectedOutput: "",
      expectedError: /^Sandbox timed out after 0\.025 seconds$/,
      expectPrevented: false,
    },
  ];

  for (const row of cases) {
    const controller = new AbortController();
    if (row.preAbort) controller.abort();
    const prevented: string[] = [];
    let configCalls = 0;
    let wrapCalls = 0;
    let cleanupCalls = 0;
    let output = "";

    const operations = createSandboxedBashOperations(
      {
        isAvailable: () => true,
        unavailableReason: () => "unused",
        onCleanupFailure: () => assert.fail("cleanup must not fail"),
        onExecutionPrevented: (command) => prevented.push(command),
        customConfigFor: async () => {
          configCalls += 1;
          if (row.abortInConfig) controller.abort();
          return baseConfig;
        },
      },
      {
        wrapWithSandbox: (command) => {
          wrapCalls += 1;
          return row.wrap(command, controller);
        },
        annotateStderrWithSandboxFailures: (_id, stderr) => stderr,
        cleanupAfterCommand: () => {
          cleanupCalls += 1;
        },
      },
    );

    if (row.abortAfterMs !== undefined) {
      setTimeout(() => controller.abort(), row.abortAfterMs);
    }

    await assert.rejects(
      operations.exec(row.command, process.cwd(), {
        signal: controller.signal,
        ...(row.timeout !== undefined ? { timeout: row.timeout } : {}),
        onData: (data) => {
          output += data.toString();
        },
      }),
      (error: Error) => {
        assert.match(error.message, row.expectedError, row.name);
        return true;
      },
    );
    assert.equal(configCalls, row.expectedConfigCalls, row.name);
    assert.equal(wrapCalls, row.expectedWrapCalls, row.name);
    assert.equal(cleanupCalls, row.expectedCleanupCalls, row.name);
    assert.equal(output, row.expectedOutput, row.name);
    assert.deepEqual(prevented, row.expectPrevented ? [row.command] : [], row.name);
  }
});

test("spawn error reports Command cancelled only when aborted", async () => {
  const baseConfig: SandboxRuntimeConfig = {
    filesystem: { allowRead: [], denyRead: [], allowWrite: [], denyWrite: [] },
    network: { allowedDomains: [], deniedDomains: [] },
  };
  const missingCwd = join(tmpdir(), `pi-gear-missing-cwd-${process.pid}-${Date.now()}`);
  const cases = [
    {
      name: "spawn error without abort reports sandbox process failure",
      abortAfterSpawn: false,
      expectedError: /Sandbox process failed:/,
    },
    {
      name: "spawn error while aborted reports Command cancelled",
      abortAfterSpawn: true,
      expectedError: /^Command cancelled$/,
    },
  ];

  for (const row of cases) {
    const controller = new AbortController();
    let resolveWrap!: (value: string) => void;
    let signalWrapStarted!: () => void;
    const wrapStarted = new Promise<void>((resolve) => {
      signalWrapStarted = resolve;
    });
    const wrapPromise = new Promise<string>((resolve) => {
      resolveWrap = resolve;
    });
    let cleanupCalls = 0;

    const operations = createSandboxedBashOperations(
      {
        isAvailable: () => true,
        unavailableReason: () => "unused",
        onCleanupFailure: () => assert.fail("cleanup must not fail"),
        onExecutionPrevented: () => assert.fail("execution unexpectedly prevented"),
        customConfigFor: async () => baseConfig,
      },
      {
        wrapWithSandbox: () => {
          signalWrapStarted();
          return wrapPromise;
        },
        annotateStderrWithSandboxFailures: (_id, stderr) => stderr,
        cleanupAfterCommand: () => {
          cleanupCalls += 1;
        },
      },
    );

    const execution = operations.exec("echo hi", missingCwd, {
      signal: controller.signal,
      onData: () => undefined,
    });
    await wrapStarted;
    resolveWrap("echo hi");
    if (row.abortAfterSpawn) {
      await Promise.resolve();
      controller.abort();
    }

    await assert.rejects(
      execution,
      (error: Error) => {
        assert.match(error.message, row.expectedError, row.name);
        return true;
      },
    );
    assert.equal(cleanupCalls, 1, row.name);
  }
});
