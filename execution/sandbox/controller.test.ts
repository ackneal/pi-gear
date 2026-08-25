import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
  const controller = new SandboxController(() => undefined, manager, async () => ({
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
