import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupLifecycle } from "./index.ts";
import type { FffSidecar } from "./fff.ts";
import type { FffClient } from "./fff-client.ts";
import { FFF_SOCKET_ENV } from "./fff-protocol.ts";

function lifecycleHarness() {
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      const current = handlers.get(event) ?? [];
      current.push(handler);
      handlers.set(event, current);
    },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: "/workspace" } as ExtensionContext;
  return {
    pi,
    ctx,
    handlers,
    emit: async (event: string) => {
      for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
    },
  };
}

for (const endpoint of [undefined, "/tmp/inherited-fff.sock"]) {
  test(`child lifecycle does not own FFF ${endpoint ? "with" : "without"} an inherited endpoint`, async (t) => {
    const previous = process.env[FFF_SOCKET_ENV];
    t.after(() => {
      if (previous === undefined) delete process.env[FFF_SOCKET_ENV];
      else process.env[FFF_SOCKET_ENV] = previous;
    });
    if (endpoint === undefined) delete process.env[FFF_SOCKET_ENV];
    else process.env[FFF_SOCKET_ENV] = endpoint;

    const { pi, ctx, handlers, emit } = lifecycleHarness();
    let starts = 0;
    let disposals = 0;
    const lifecycle = setupLifecycle(pi, {
      child: true,
      startFff: async () => {
        starts += 1;
        return { dispose: async () => { disposals += 1; } } as unknown as FffSidecar;
      },
    });
    assert.ok(handlers.has("turn_end"));
    assert.ok(handlers.has("agent_start"));
    assert.ok(handlers.has("agent_settled"));
    for (const event of ["session_start", "session_start", "session_shutdown"]) {
      await emit(event);
      for (const cwd of [undefined, ctx.cwd, "/other"]) {
        assert.equal(lifecycle.fff.current(cwd), undefined);
        assert.equal(lifecycle.fff.endpoint(cwd), undefined);
        assert.equal(lifecycle.fff.failure(cwd), undefined);
      }
    }
    assert.equal(starts, 0);
    assert.equal(disposals, 0);
    assert.equal(process.env[FFF_SOCKET_ENV], endpoint);
  });
}

for (const child of [undefined, false]) {
  test(`parent lifecycle owns FFF when child is ${child}`, async () => {
    const { pi, ctx, emit } = lifecycleHarness();
    const client = {} as FffClient;
    let starts = 0;
    let disposals = 0;
    const lifecycle = setupLifecycle(pi, {
      ...(child === undefined ? {} : { child }),
      startFff: async (cwd) => {
        assert.equal(cwd, ctx.cwd);
        starts += 1;
        return {
          basePath: cwd,
          socketPath: "/tmp/owned-fff.sock",
          client,
          dispose: async () => { disposals += 1; },
        } as unknown as FffSidecar;
      },
    });
    await emit("session_start");
    assert.equal(lifecycle.fff.current(ctx.cwd), client);
    assert.equal(lifecycle.fff.endpoint(ctx.cwd), "/tmp/owned-fff.sock");
    assert.equal(lifecycle.fff.current("/other"), undefined);
    assert.equal(lifecycle.fff.endpoint("/other"), undefined);
    await emit("session_start");
    assert.equal(starts, 2);
    assert.equal(disposals, 1);
    await emit("session_shutdown");
    assert.equal(disposals, 2);
    assert.equal(lifecycle.fff.current(), undefined);
    assert.equal(lifecycle.fff.endpoint(), undefined);
    assert.equal(lifecycle.fff.failure(), undefined);
  });
}

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
