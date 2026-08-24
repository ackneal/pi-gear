import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lspErrorPatch, primeLspErrors, setupLsp } from "./index.ts";
import type { LspManager } from "./manager.ts";

const event = (toolName: string, isError = false) => ({
  toolName,
  isError,
  input: { path: "source.ts" },
  content: [{ type: "text" as const, text: "Updated source.ts" }],
});

test("successful edit/write surface only new LSP errors", async () => {
  let calls = 0;
  const manager = {
    match: (path: string) => path.endsWith(".ts") ? {} : undefined,
    newErrors: async () => {
      calls++;
      return calls === 1
        ? [{ path: "source.ts", line: 2, column: 3, severity: "error", message: "broken" }]
        : [];
    },
  } as unknown as LspManager;

  const first = await lspErrorPatch(manager, event("edit"));
  assert.match(first?.content.at(-1)?.text ?? "", /New LSP errors:\nsource\.ts:2:3 error: broken/);
  assert.equal(await lspErrorPatch(manager, event("write")), undefined);
  assert.equal(await lspErrorPatch(manager, event("read")), undefined);
  assert.equal(await lspErrorPatch(manager, event("edit", true)), undefined);
  assert.equal(calls, 2);
});

test("automatic edit/write LSP failures are advisory", async () => {
  const manager = {
    match: () => ({}),
    primeErrors: async () => { throw new Error("prime failed"); },
    newErrors: async () => { throw new Error("sync failed"); },
  } as unknown as LspManager;

  await assert.doesNotReject(primeLspErrors(manager, "source.ts"));
  assert.equal(await lspErrorPatch(manager, event("edit")), undefined);
});

test("empty LSP server configuration does not set up a manager, tools, or watchers", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools: string[] = [];
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    registerTool: (tool: { name: string }) => { tools.push(tool.name); },
  } as unknown as ExtensionAPI;
  const loadConfig = async () => ({
    version: 1,
    filesystem: { rules: [] },
    network: { rules: [] },
    lsp: { servers: [] },
  }) as const;

  const services = setupLsp(pi, loadConfig as never);
  await handlers.get("session_start")?.({}, { cwd: "/definitely-not-a-workspace" });

  assert.deepEqual(tools, []);
  assert.deepEqual(await services.statuses("/definitely-not-a-workspace"), []);
  await handlers.get("session_shutdown")?.();
});
