import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initRostrix, ROSTRIX_RUNTIME_SYMBOL, ProfileValidationError } from "../src/index.ts";

function createMockPi(): { pi: ExtensionAPI; shutdown: () => void } {
  const listeners = new Map<string, Array<() => void>>();
  const pi = {
    on: (event: string, handler: () => void) => {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
  } as unknown as ExtensionAPI;

  return {
    pi,
    shutdown: () => {
      for (const handler of listeners.get("session_shutdown") ?? []) {
        handler();
      }
    },
  };
}

test("initRostrix creates a singleton runtime and attaches to globalThis", () => {
  const { pi, shutdown } = createMockPi();
  try {
    const runtime1 = initRostrix(pi);
    assert.equal(runtime1.isInitialized, true);
    assert.equal(runtime1.version, "0.1.0");

    // Second call returns the exact same singleton instance
    const runtime2 = initRostrix(pi);
    assert.strictEqual(runtime1, runtime2);
    assert.strictEqual((globalThis as any)[ROSTRIX_RUNTIME_SYMBOL], runtime1);

    // Profile registration and retrieval
    runtime1.registerProfile({ id: "test:agent", label: "Test Agent", description: "Test Description" });
    assert.deepEqual(runtime1.getProfile("test:agent"), { id: "test:agent", label: "Test Agent", description: "Test Description" });
    assert.equal(runtime1.getAllProfiles().length, 1);

    // Duplicate registration throws
    assert.throws(() => {
      runtime1.registerProfile({ id: "test:agent", label: "Test Agent", description: "Test Description" });
    }, /already registered/);

    // Invalid profile throws ProfileValidationError
    assert.throws(() => {
      runtime1.registerProfile({} as any);
    }, ProfileValidationError);
  } finally {
    shutdown();
    assert.equal((globalThis as any)[ROSTRIX_RUNTIME_SYMBOL], undefined);
  }
});
