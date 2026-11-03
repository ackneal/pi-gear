import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { normalizeTempAlias } from "./config.ts";
import { SandboxController, type SandboxManagerLike } from "./controller.ts";

test("sandbox lifecycle serializes shutdown behind an in-flight start", { skip: process.platform !== "darwin" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-gear-controller-"));
  let enabled = false;
  let releaseInitialization!: () => void;
  let signalInitialized!: () => void;
  const initialized = new Promise<void>((resolve) => { signalInitialized = resolve; });
  const initializationFinished = new Promise<void>((resolve) => { releaseInitialization = resolve; });
  const events: string[] = [];
  const manager: SandboxManagerLike = {
    isSandboxingEnabled: () => enabled,
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [] }),
    initialize: async () => {
      events.push("initialize");
      signalInitialized();
      await initializationFinished;
      enabled = true;
    },
    reset: async () => {
      events.push("reset");
      enabled = false;
    },
  };
  const ctx = {
    cwd: workspace,
    hasUI: false,
    ui: { confirm: async () => false, notify: () => undefined },
  } as unknown as ExtensionContext;
  const controller = new SandboxController(manager, async () => ({
    version: 1,
    filesystem: { rules: [] },
    sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
  }));

  try {
    const starting = controller.start(ctx);
    await initialized;
    const shuttingDown = controller.shutdown();
    await Promise.resolve();
    assert.deepEqual(events, ["initialize"]);

    releaseInitialization();
    await starting;
    await shuttingDown;
    assert.deepEqual(events, ["initialize", "reset"]);
    assert.equal(controller.status().enabled, false);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("customConfigFor merges dynamic session approvals into sandbox filesystem allowWrite", { skip: process.platform !== "darwin" }, async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-gear-dynamic-"));
  const projectDir = await mkdtemp(join(tmpdir(), "pi-gear-project-"));
  const readonlyDir = await mkdtemp(join(tmpdir(), "pi-gear-readonly-"));

  const manager: SandboxManagerLike = {
    isSandboxingEnabled: () => false,
    isSupportedPlatform: () => true,
    checkDependenciesAsync: async () => ({ errors: [] }),
    initialize: async () => undefined,
    reset: async () => undefined,
  };

  let sessionRules = [
    { path: `${projectDir}/**`, access: "read-write" as const },
    { path: `${readonlyDir}/**`, access: "read-only" as const },
  ];

  const controller = new SandboxController(
    manager,
    async () => ({
      version: 1,
      filesystem: { rules: [{ path: "~/.ssh", access: "deny" }] },
      sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
    }),
    undefined,
    (baseRules) => [...baseRules, ...sessionRules],
  );

  const ctx = {
    cwd: workspace,
    hasUI: false,
    ui: { confirm: async () => false, notify: () => undefined },
  } as unknown as ExtensionContext;

  try {
    await controller.start(ctx);

    // Access customConfigFor via operations
    let capturedConfig: any;
    const dummyOps = controller.operations;
    // We can directly call the private sessionConfig via customConfigFor if exposed or inspect through customConfigFor
    // In spawn.ts, callbacks.customConfigFor is passed to wrapWithSandbox. Let's test the config generated:
    // Normalize /tmp on macOS
    const expectedProject = normalizeTempAlias(`${projectDir}/**`);
    const expectedReadonly = normalizeTempAlias(`${readonlyDir}/**`);

    const customConfig = await (controller as any).sessionConfig();

    // 1. read-write session approval must be in allowWrite
    assert.ok(customConfig.filesystem.allowWrite.includes(expectedProject));

    // 2. read-only session approval must NOT be in allowWrite
    assert.ok(!customConfig.filesystem.allowWrite.includes(expectedReadonly));

    // 3. read-only session approval must be in denyWrite
    assert.ok(customConfig.filesystem.denyWrite.includes(expectedReadonly));

    // 4. Deny rules remain in denyRead and denyWrite
    assert.ok(customConfig.filesystem.denyRead.some((r: string) => r.includes(".ssh")));
    assert.ok(customConfig.filesystem.denyWrite.some((r: string) => r.includes(".ssh")));

    // 5. When session rules clear (e.g. session reset), next command does not have projectDir in allowWrite
    sessionRules = [];
    const clearedConfig = await (controller as any).sessionConfig();
    assert.ok(!clearedConfig.filesystem.allowWrite.includes(expectedProject));
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
    await rm(readonlyDir, { recursive: true, force: true });
  }
});
