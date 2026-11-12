import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { init, RUNTIME_SYMBOL, AgentValidationError } from "../src/index.ts";

function createMockPi(): { pi: ExtensionAPI; shutdown: () => Promise<void> } {
  const listeners = new Map<string, Array<() => void | Promise<void>>>();
  const tools: any[] = [];
  const pi = {
    on: (event: string, handler: () => void | Promise<void>) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
      return () => {
        const index = list.indexOf(handler);
        if (index >= 0) list.splice(index, 1);
      };
    },
    registerTool: (tool: any) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    shutdown: async () => {
      for (const handler of [...(listeners.get("session_shutdown") ?? [])]) {
        await handler();
      }
    },
  };
}

test("session shutdown awaits task cleanup before disposing runtime state", async () => {
  const { pi, shutdown } = createMockPi();
  const runtime = init(pi, { autoLoadDefinitions: false, autoRegisterAgentControls: false });
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const originalShutdown = runtime.tasks.shutdown.bind(runtime.tasks);
  runtime.tasks.shutdown = async () => {
    await originalShutdown();
    await cleanup;
  };

  try {
    const pending = shutdown();
    await Promise.resolve();
    assert.equal(runtime.isInitialized, true);
    release();
    await pending;
    assert.equal(runtime.isInitialized, false);
    assert.equal((globalThis as any)[RUNTIME_SYMBOL], undefined);
  } finally {
    release();
    await runtime.dispose();
  }
});

test("init creates a singleton runtime and attaches to globalThis", async () => {
  const { pi, shutdown } = createMockPi();
  try {
    const runtime1 = init(pi);
    assert.equal(runtime1.isInitialized, true);
    assert.equal(runtime1.version, "0.1.0");

    // Second call returns the exact same singleton instance
    const runtime2 = init(pi);
    assert.strictEqual(runtime1, runtime2);
    assert.strictEqual((globalThis as any)[RUNTIME_SYMBOL], runtime1);

    // Profile registration and retrieval
    runtime1.registerAgent({ id: "test:agent", label: "Test Agent", description: "Test Description" });
    assert.deepEqual(runtime1.getAgent("test:agent"), { id: "test:agent", label: "Test Agent", description: "Test Description" });
    assert.equal(runtime1.getAllAgents().length, 1);

    // Duplicate registration throws
    assert.throws(() => {
      runtime1.registerAgent({ id: "test:agent", label: "Test Agent", description: "Test Description" });
    }, /already registered/);

    // Invalid profile throws AgentValidationError
    assert.throws(() => {
      runtime1.registerAgent({} as any);
    }, AgentValidationError);
  } finally {
    await shutdown();
    assert.equal((globalThis as any)[RUNTIME_SYMBOL], undefined);
  }
});
