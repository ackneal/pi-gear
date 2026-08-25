import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { lspDiagnosticsPatch, primeLspDiagnostics, setupLsp } from "./index.ts";
import type { LspManager } from "./manager.ts";

const event = (toolName: string, isError = false) => ({
  toolName,
  isError,
  input: { path: "source.ts" },
  content: [{ type: "text" as const, text: "Updated source.ts" }],
});

test("automatic diagnostics render error details and collapse other severities to counts", async () => {
  const cases = [
    {
      name: "mixed diagnostics",
      diagnostics: [
        { path: "src/a.rs", line: 12, column: 5, endLine: 12, endColumn: 6, severity: "error" as const, code: "E0308", message: "mismatched types" },
        { path: "src/b.rs", line: 30, column: 9, endLine: 30, endColumn: 10, severity: "error" as const, message: "unresolved import `Foo`" },
        { path: "src/c.rs", line: 18, column: 3, endLine: 18, endColumn: 4, severity: "warning" as const, message: "hidden warning" },
        { path: "src/c.rs", line: 19, column: 3, endLine: 19, endColumn: 4, severity: "information" as const, message: "hidden information" },
        { path: "src/c.rs", line: 20, column: 3, endLine: 20, endColumn: 4, severity: "hint" as const, message: "hidden hint" },
      ],
      expected: [
        "LSP",
        "2 errors · 1 warning · 2 suggestions",
        "src/a.rs:12:5 [error E0308] mismatched types",
        "src/b.rs:30:9 [error] unresolved import `Foo`",
      ].join("\n"),
    },
    {
      name: "counts without errors",
      diagnostics: [
        { path: "a.go", line: 1, column: 1, endLine: 1, endColumn: 2, severity: "warning" as const, message: "hidden" },
        { path: "a.go", line: 2, column: 1, endLine: 2, endColumn: 2, severity: "hint" as const, message: "hidden" },
      ],
      expected: "LSP\n1 warning · 1 suggestion",
    },
  ];

  for (const { name, diagnostics, expected } of cases) {
    const manager = {
      match: () => ({}),
      changedDiagnostics: async () => diagnostics,
    } as unknown as LspManager;

    const result = await lspDiagnosticsPatch(manager, event("edit"));

    assert.equal(result?.content.at(-1)?.text, expected, name);
  }
});

test("successful edit/write hide automatic feedback when the diff is empty", async () => {
  let calls = 0;
  const manager = {
    match: (path: string) => path.endsWith(".ts") ? {} : undefined,
    changedDiagnostics: async () => { calls++; return []; },
  } as unknown as LspManager;

  assert.equal(await lspDiagnosticsPatch(manager, event("edit")), undefined);
  assert.equal(await lspDiagnosticsPatch(manager, event("read")), undefined);
  assert.equal(await lspDiagnosticsPatch(manager, event("edit", true)), undefined);
  assert.equal(calls, 1);
});

test("automatic edit/write LSP failures are advisory", async () => {
  const manager = {
    match: () => ({}),
    primeDiagnostics: async () => { throw new Error("prime failed"); },
    changedDiagnostics: async () => { throw new Error("sync failed"); },
  } as unknown as LspManager;

  await assert.doesNotReject(primeLspDiagnostics(manager, "source.ts"));
  assert.equal(await lspDiagnosticsPatch(manager, event("edit")), undefined);
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
