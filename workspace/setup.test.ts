import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FilesystemAccessService } from "../execution/filesystem/guard.ts";
import { FffClient } from "../lifecycle/fff-client.ts";
import { FFF_SOCKET_ENV } from "../lifecycle/fff-protocol.ts";
import { setupLifecycle } from "../lifecycle/index.ts";
import { setupWorkspace } from "./setup.ts";

test("child workspace reuses the parent socket and closes only its connection", async (t) => {
  const previous = process.env[FFF_SOCKET_ENV];
  process.env[FFF_SOCKET_ENV] = "/tmp/parent-fff.sock";
  t.after(() => {
    if (previous === undefined) delete process.env[FFF_SOCKET_ENV];
    else process.env[FFF_SOCKET_ENV] = previous;
  });
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const registered: string[] = [];
  const calls: string[] = [];
  const client = {
    close: () => { calls.push("close"); },
    request: async (method: string) => { assert.fail(`unexpected parent request: ${method}`); },
    subscribe: async () => async () => undefined,
  } as unknown as FffClient;
  t.mock.method(FffClient, "connect", async (endpoint: string) => {
    calls.push(`connect:${endpoint}`);
    return client;
  });
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => { registered.push(tool.name); },
    getActiveTools: () => ["find", "grep"],
    setActiveTools: () => undefined,
  } as unknown as ExtensionAPI;
  const lifecycle = setupLifecycle(pi, {
    child: true,
    startFff: async () => { assert.fail("child must not start a sidecar"); },
  });
  const filesystem = { forWorkspace: () => ({}) } as unknown as FilesystemAccessService;
  const services = setupWorkspace(pi, filesystem, lifecycle.fff);
  const ctx = { cwd: "/workspace", hasUI: false } as ExtensionContext;

  for (const handler of handlers.get("session_start") ?? []) await handler({}, ctx);
  assert.ok(services.current(ctx.cwd));
  assert.equal(services.endpoint(ctx.cwd), "/tmp/parent-fff.sock");
  assert.deepEqual(registered, ["find", "grep"]);
  for (const handler of handlers.get("session_shutdown") ?? []) await handler({}, ctx);

  assert.deepEqual(calls, ["connect:/tmp/parent-fff.sock", "close"]);
  assert.equal(services.current(ctx.cwd), undefined);
});

const item = (relativePath: string) => ({
  relativePath,
  fileName: relativePath,
  size: 1,
  modified: 1,
  accessFrecencyScore: 0,
  modificationFrecencyScore: 0,
  totalFrecencyScore: 0,
  gitStatus: "clean",
});

test("a canceled session switch leaves the original workspace find and grep usable", async () => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const tools = new Map<string, ToolDefinition>();
  const client = {
    request: async (method: string) => {
      if (method === "glob") return { items: [item("kept.ts")], scores: [], totalMatched: 1, totalFiles: 1 };
      if (method === "grep") return {
        items: [{ ...item("kept.ts"), isBinary: false, lineNumber: 1, col: 0, byteOffset: 0, lineContent: "still usable", matchRanges: [] }],
        nextCursor: null,
      };
      throw new Error(method);
    },
    subscribe: async () => async () => undefined,
  } as unknown as FffClient;
  const access = { filter: async (paths: readonly string[]) => paths };
  const filesystem = { forWorkspace: () => access } as unknown as FilesystemAccessService;
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    getActiveTools: () => [],
    setActiveTools: () => undefined,
  } as unknown as ExtensionAPI;
  const services = setupWorkspace(pi, filesystem, {
    current: () => client,
    endpoint: () => undefined,
  });
  const ctx = { cwd: process.cwd(), hasUI: false } as ExtensionContext;

  await handlers.session_start?.({}, ctx);
  const original = services.current(ctx.cwd);
  assert.ok(original);
  assert.deepEqual([...tools.keys()].sort(), ["find", "grep"]);
  assert.equal(handlers.session_before_switch, undefined);

  // A canceled switch emits no subsequent session_start; existing tool closures must remain valid.
  const run = (name: "find" | "grep", input: Record<string, unknown>) =>
    tools.get(name)!.execute("id", input, undefined, undefined, ctx as never);
  const find = await run("find", { pattern: "*" });
  const grep = await run("grep", { pattern: "usable", literal: true });

  assert.equal(services.current(ctx.cwd), original);
  for (const toolName of ["find", "grep"]) {
    assert.equal(await handlers.tool_call?.({ toolName }, ctx), undefined);
  }
  assert.match(JSON.stringify(find), /kept\.ts/);
  assert.match(JSON.stringify(grep), /still usable/);
});

test("unavailable FFF omits workspace tools and preserves its diagnostic", async () => {
  const handlers: Record<string, (...args: any[]) => any> = {};
  const registered: string[] = [];
  let activeTools = ["read", "find", "grep", "write"];
  const filesystem = { forWorkspace: () => ({}) } as unknown as FilesystemAccessService;
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    registerTool: (tool: ToolDefinition) => registered.push(tool.name),
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  } as unknown as ExtensionAPI;
  const services = setupWorkspace(pi, filesystem, {
    current: () => undefined,
    endpoint: () => undefined,
    failure: () => "FFF sidecar unavailable: Bun executable not found",
  });
  const ctx = { cwd: "/workspace", hasUI: false } as ExtensionContext;

  await handlers.session_start?.({}, ctx);

  assert.deepEqual(registered, []);
  assert.deepEqual(activeTools, ["read", "write"]);
  assert.equal(services.current(ctx.cwd), undefined);
  assert.equal((await services.status(ctx.cwd))?.error, "FFF sidecar unavailable: Bun executable not found");
  for (const name of ["find", "grep"]) {
    assert.deepEqual(await handlers.tool_call?.({ toolName: name }, ctx), {
      block: true,
      reason: "FFF sidecar unavailable: Bun executable not found",
    });
  }
  assert.equal(await handlers.tool_call?.({ toolName: "read" }, ctx), undefined);
});

test("failed child FFF connection blocks search reactivated by MCP registration", async (t) => {
  t.mock.method(FffClient, "connect", async () => { throw new Error("Parent FFF socket unavailable"); });
  const handlers: Record<string, (...args: any[]) => any> = {};
  const allowedTools = ["read", "find", "grep", "mcp__exa__web_search_exa"];
  let activeTools = [...allowedTools];
  const pi = {
    on: (event: string, handler: (...args: any[]) => any) => { handlers[event] = handler; },
    // Pi 1.0 registry refresh reactivates tools named in the CLI allowlist.
    registerTool: () => { activeTools = [...allowedTools]; },
    getActiveTools: () => activeTools,
    setActiveTools: (tools: string[]) => { activeTools = tools; },
  } as unknown as ExtensionAPI;
  const filesystem = { forWorkspace: () => { assert.fail("failed connection must not initialize search"); } } as unknown as FilesystemAccessService;
  setupWorkspace(pi, filesystem, {
    current: () => undefined,
    endpoint: () => "/tmp/unavailable-parent-fff.sock",
  });
  const ctx = { cwd: "/workspace", hasUI: false } as ExtensionContext;

  assert.ok(handlers.session_start);
  assert.ok(handlers.tool_call);
  await handlers.session_start({}, ctx);
  assert.ok(!activeTools.includes("find") && !activeTools.includes("grep"));
  pi.registerTool({ name: "mcp__exa__web_search_exa" } as ToolDefinition);

  for (const toolName of ["find", "grep"]) {
    assert.ok(activeTools.includes(toolName));
    assert.deepEqual(await handlers.tool_call({ toolName }, ctx), {
      block: true,
      reason: "Parent FFF socket unavailable",
    });
  }
  assert.equal(await handlers.tool_call({ toolName: "mcp__exa__web_search_exa" }, ctx), undefined);
});
