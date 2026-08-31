import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FilesystemAccessService } from "../execution/filesystem/guard.ts";
import type { FffClient } from "../lifecycle/fff-client.ts";
import { setupWorkspace } from "./setup.ts";

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
  assert.equal(handlers.session_before_switch, undefined);

  // A canceled switch emits no subsequent session_start; existing tool closures must remain valid.
  const run = (name: "find" | "grep", input: Record<string, unknown>) =>
    tools.get(name)!.execute("id", input, undefined, undefined, ctx as never);
  const find = await run("find", { pattern: "*" });
  const grep = await run("grep", { pattern: "usable", literal: true });

  assert.equal(services.current(ctx.cwd), original);
  assert.match(JSON.stringify(find), /kept\.ts/);
  assert.match(JSON.stringify(grep), /still usable/);
});
