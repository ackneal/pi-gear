import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lspDiagnosticsPatch, primeLspDiagnostics, setupLsp } from "./index.ts";
import { LspManager } from "./manager.ts";

const event = (toolName: string, isError = false) => ({
  toolName,
  isError,
  input: { path: "source.ts" },
  content: [{ type: "text" as const, text: "Updated source.ts" }],
});

test("LSP tool contracts describe optional diagnostics scope and unchanged navigation parameters", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-contract-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, handler: (...args: any[]) => any) => { handlers.set(name, handler); },
    registerTool: (tool: any) => { tools.set(tool.name, tool); },
  } as unknown as ExtensionAPI;
  const loadConfig = async () => ({
    version: 1,
    filesystem: { rules: [] },
    sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
    lsp: {
      servers: [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
      idleTimeoutMinutes: 0,
    },
  }) as const;
  const startWatching = LspManager.prototype.startWatching;
  LspManager.prototype.startWatching = () => {};

  try {
    setupLsp(pi, {
      workspace: {
        current: () => ({
          initialize: async () => undefined,
          files: async () => [],
          dirtyFiles: async () => [],
          onChange: () => () => undefined,
        }) as never,
        status: () => undefined,
      },
      loadConfig: loadConfig as never,
    });
    await handlers.get("session_start")?.({}, { cwd });
    const diagnostics = tools.get("diagnostics");
    const navigation = tools.get("navigation");

    assert.equal(diagnostics.description, "Inspect language-server diagnostics for changed files or the workspace.");
    assert.equal(diagnostics.promptSnippet, "Use diagnostics to check code errors, warnings, and suggestions after changes or during verification.");
    assert.equal(diagnostics.parameters.required, undefined);
    assert.equal(diagnostics.parameters.properties.scope.description, "Diagnostic scope. Defaults to changed files; use workspace to inspect the full workspace.");
    assert.deepEqual(diagnostics.parameters.properties.scope.anyOf.map((entry: any) => entry.const), ["changed", "workspace"]);
    assert.deepEqual((await diagnostics.execute("default", {})).details.diagnostics, []);
    assert.deepEqual((await diagnostics.execute("workspace", { scope: "workspace" })).details.diagnostics, []);

    assert.equal(navigation.description, "Find symbol definitions or references using the language server. Path and positions are 1-based.");
    assert.equal(navigation.promptSnippet, "Use navigation to locate a symbol's definition or references when tracing code relationships.");
    assert.deepEqual(navigation.parameters.required, ["action", "path", "line", "column"]);
    assert.equal(navigation.parameters.properties.action.description, "Navigation operation.");
    assert.equal(navigation.parameters.properties.path.description, "Source file path.");
    assert.equal(navigation.parameters.properties.line.description, "1-based source line.");
    assert.equal(navigation.parameters.properties.line.minimum, 1);
    assert.equal(navigation.parameters.properties.column.description, "1-based source column.");
    assert.equal(navigation.parameters.properties.column.minimum, 1);
  } finally {
    await handlers.get("session_shutdown")?.();
    LspManager.prototype.startWatching = startWatching;
    await rm(cwd, { recursive: true, force: true });
  }
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

test("failed edit/write clears its pre-edit diagnostic baseline", async () => {
  const manager = new LspManager([{
    extensions: [".ts"],
    languageIds: { ".ts": "typescript" },
    command: ["server"],
  }], "/workspace");
  let syncCalls = 0;
  manager.sync = async () => {
    syncCalls++;
    return [{
      path: "source.ts", line: 1, column: 1, endLine: 1, endColumn: 2,
      severity: "error", message: "existing diagnostic",
    }];
  };

  await manager.primeDiagnostics("source.ts");
  assert.equal(await lspDiagnosticsPatch(manager, event("edit", true)), undefined);
  assert.deepEqual(await manager.changedDiagnostics("source.ts"), []);
  assert.equal(syncCalls, 1);
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
    sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
    lsp: { servers: [] },
  }) as const;

  const services = setupLsp(pi, { loadConfig: loadConfig as never });
  await handlers.get("session_start")?.({}, { cwd: "/definitely-not-a-workspace" });

  assert.deepEqual(tools, []);
  assert.deepEqual(await services.statuses("/definitely-not-a-workspace"), []);
  await handlers.get("session_shutdown")?.();
});
