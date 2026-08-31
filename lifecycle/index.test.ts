import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupLifecycle } from "./index.ts";

test("lifecycle preserves FFF startup failures without failing session startup", async () => {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;
  const lifecycle = setupLifecycle(pi, {
    startFff: async () => { throw new Error("Bun executable not found"); },
  });
  const ctx = { cwd: "/workspace" } as ExtensionContext;

  await Promise.all((handlers.get("session_start") ?? []).map((handler) => handler({}, ctx)));

  assert.equal(lifecycle.fff.current(ctx.cwd), undefined);
  assert.equal(lifecycle.fff.endpoint(ctx.cwd), undefined);
  assert.equal(lifecycle.fff.failure(ctx.cwd), "FFF sidecar unavailable: Bun executable not found");
  assert.equal(lifecycle.fff.failure("/other"), undefined);
});
