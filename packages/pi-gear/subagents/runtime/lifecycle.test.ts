import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupSubagentRuntimeLifecycle } from "./lifecycle.ts";

test("only authoritative session shutdown cancels and awaits background runtime", async () => {
  const handlers = new Map<string, () => unknown>();
  let starts = 0;
  let shutdowns = 0;
  let releaseShutdown!: () => void;
  const shutdown = new Promise<void>((resolve) => { releaseShutdown = resolve; });
  const pi = { on: (event: string, handler: () => unknown) => { handlers.set(event, handler); } } as unknown as ExtensionAPI;

  setupSubagentRuntimeLifecycle(pi, {
    beginSession: () => { starts++; },
    shutdown: () => { shutdowns++; return shutdown; },
  });

  assert.equal(handlers.has("session_before_switch"), false);
  handlers.get("session_start")?.();
  assert.equal(starts, 1);
  assert.equal(shutdowns, 0);

  let settled = false;
  const result = handlers.get("session_shutdown")?.() as Promise<void>;
  result.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(shutdowns, 1);
  assert.equal(settled, false);

  releaseShutdown();
  await result;
  assert.equal(settled, true);
});
