import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { LspClient } from "./client.ts";
import { LspManager } from "./manager.ts";
import { formatDiagnostics, normalizeDiagnostics } from "./normalize.ts";
import type { DiagnosticSeverity, NormalizedDiagnostic } from "./types.ts";

const exec = promisify(execFile);

class FakeClient {
  syncCount = 0;
  shutdownCount = 0;
  lastNavigation: unknown;
  running = false;
  activeWaits = 0;
  maxActiveWaits = 0;
  private readonly target: string;
  private readonly shutdownDelayMs: number;
  constructor(target: string, shutdownDelayMs = 0) {
    this.target = target;
    this.shutdownDelayMs = shutdownDelayMs;
  }
  diagnosticsRevision(): number { return 0; }
  async sync(): Promise<void> { this.running = true; this.syncCount++; }
  async waitForDiagnostics(): Promise<void> {
    this.activeWaits++;
    this.maxActiveWaits = Math.max(this.maxActiveWaits, this.activeWaits);
    await new Promise((resolve) => setTimeout(resolve, 5));
    this.activeWaits--;
  }
  diagnosticsFor() {
    return [
      { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }, severity: 1, code: 10, message: " first\nerror " },
      { range: { start: { line: 4, character: 5 }, end: { line: 4, character: 6 } }, severity: 2, message: "warning" },
      { range: { start: { line: 7, character: 8 }, end: { line: 7, character: 9 } }, severity: 3, message: "ignore" },
    ];
  }
  async navigate(method: string, path: string, position: unknown): Promise<unknown> {
    this.running = true;
    this.lastNavigation = { method, path, position };
    return [{
      uri: pathToFileURL(this.target).href,
      range: { start: { line: 8, character: 9 }, end: { line: 8, character: 10 } },
    }];
  }
  async shutdown(): Promise<void> {
    this.running = false;
    this.shutdownCount++;
    if (this.shutdownDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.shutdownDelayMs));
  }
}

test("manager matches configured extensions, reuses clients, normalizes diagnostics, and maps navigation positions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-manager-"));
  const source = join(cwd, "source.ts");
  await writeFile(source, "const value = 1;\n");
  const fake = new FakeClient(source);
  const manager = new LspManager(
    [{ extensions: [".ts", ".tsx"], languageIds: { ".ts": "typescript", ".tsx": "typescriptreact" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
  );

  try {
    await manager.initializeWorkspace();
    assert.ok(manager.match(source));
    assert.equal(manager.match(join(cwd, "source.go")), undefined);

    const first = await manager.sync(source);
    const second = await manager.sync(source);
    assert.equal(fake.syncCount, 2);
    assert.deepEqual(first, second);
    assert.equal(formatDiagnostics(first), "source.ts:2:3 [error] 10\nfirst error\nsource.ts:5:6 [warning]\nwarning\nsource.ts:8:9 [information]\nignore");

    const locations = await manager.navigate("definition", source, 3, 4);
    assert.deepEqual(fake.lastNavigation, {
      method: "textDocument/definition",
      path: source,
      position: { line: 2, character: 3 },
    });
    assert.deepEqual(locations, [{ path: "source.ts", line: 9, column: 10 }]);
  } finally {
    await manager.shutdown();
    assert.equal(fake.shutdownCount, 1);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("diagnostic normalization preserves all severities, ranges, source, and code", () => {
  const diagnostics = normalizeDiagnostics("/workspace/a.ts", "/workspace", [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, source: "rust-analyzer", code: "E1", message: "error" },
    { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, severity: 2, source: "gopls", message: "warning" },
    { range: { start: { line: 2, character: 2 }, end: { line: 2, character: 3 } }, severity: 3, source: "basedpyright", message: "information" },
    { range: { start: { line: 3, character: 3 }, end: { line: 4, character: 4 } }, severity: 4, source: "typescript", message: "hint" },
  ]);

  assert.deepEqual(diagnostics.map(({ severity }) => severity), ["error", "warning", "information", "hint"]);
  assert.deepEqual(diagnostics.at(-1), {
    path: "a.ts", line: 4, column: 4, endLine: 5, endColumn: 5,
    severity: "hint", source: "typescript", message: "hint",
  });
  assert.match(formatDiagnostics(diagnostics.slice(0, 1)), /a\.ts:1:1 \[error\] rust-analyzer E1\nerror/);
});

test("diagnostic normalization skips unspecified severity", () => {
  const diagnostics = normalizeDiagnostics("/workspace/a.ts", "/workspace", [{
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    message: "must not become an error",
  }]);

  assert.deepEqual(diagnostics, []);
});

const normalized = (
  severity: DiagnosticSeverity,
  message: string,
  overrides: Partial<NormalizedDiagnostic> = {},
): NormalizedDiagnostic => ({
  path: "source.ts",
  line: 1,
  column: 1,
  endLine: 1,
  endColumn: 2,
  severity,
  message,
  ...overrides,
});

test("edit feedback skips diagnostics when no pre-edit baseline exists", async () => {
  const withoutBaseline = new LspManager([], "/workspace");
  let missingBaselineSyncs = 0;
  withoutBaseline.sync = async () => {
    missingBaselineSyncs++;
    return [normalized("error", "existing diagnostic")];
  };

  assert.deepEqual(await withoutBaseline.changedDiagnostics("source.ts"), []);
  assert.equal(missingBaselineSyncs, 0);

  const emptyBaseline = new LspManager([], "/workspace");
  const snapshots = [[], [normalized("error", "reliably new")]];
  emptyBaseline.sync = async () => snapshots.shift() ?? [];

  await emptyBaseline.primeDiagnostics("source.ts");
  assert.deepEqual(await emptyBaseline.changedDiagnostics("source.ts"), [normalized("error", "reliably new")]);
});

test("edit feedback returns only deduplicated new or meaningfully changed diagnostics in severity order", async () => {
  const manager = new LspManager([], "/workspace");
  const unchanged = normalized("warning", "unchanged", { source: "gopls" });
  const beforeChange = normalized("warning", "before", { line: 2, source: "basedpyright" });
  const snapshots = [
    [unchanged, beforeChange, normalized("hint", "severity change", { line: 5 })],
    [
      unchanged,
      normalized("hint", "new hint", { source: "typescript" }),
      normalized("information", "new information", { source: "basedpyright" }),
      normalized("warning", "changed message", { line: 2, source: "basedpyright" }),
      normalized("warning", "changed range", { line: 3, endLine: 4, source: "gopls" }),
      normalized("warning", "severity change", { line: 5 }),
      normalized("error", "new error", { source: "rust-analyzer" }),
      normalized("error", "new error", { source: "rust-analyzer" }),
    ],
  ];
  manager.sync = async () => snapshots.shift() ?? [];

  await manager.primeDiagnostics("source.ts");
  const feedback = await manager.changedDiagnostics("source.ts");

  assert.deepEqual(feedback.map(({ severity, message }) => [severity, message]), [
    ["error", "new error"],
    ["warning", "changed message"],
    ["warning", "changed range"],
    ["warning", "severity change"],
    ["information", "new information"],
    ["hint", "new hint"],
  ]);
});

test("diagnostics keeps changed scope Git-focused and scans workspace files concurrently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-scope-"));
  const changed = join(cwd, "changed.ts");
  const clean = join(cwd, "clean.ts");
  await writeFile(changed, "const changed = 1;\n");
  await writeFile(clean, "const clean = 1;\n");
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["add", "."], { cwd });
  await exec("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"], { cwd });
  await writeFile(changed, "const changed = 2;\n");
  const fake = new FakeClient(changed);
  const manager = new LspManager([{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }], cwd, () => fake as unknown as LspClient);

  try {
    assert.deepEqual((await manager.diagnostics("changed")).map(({ path }) => path), ["changed.ts", "changed.ts", "changed.ts"]);
    fake.maxActiveWaits = 0;
    assert.deepEqual((await manager.diagnostics("workspace")).map(({ path }) => path), [
      "changed.ts", "changed.ts", "changed.ts", "clean.ts", "clean.ts", "clean.ts",
    ]);
    assert.equal(fake.maxActiveWaits, 2);
    await rm(join(cwd, ".git"), { recursive: true, force: true });
    assert.deepEqual(await manager.diagnostics("changed"), []);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});


test("workspace diagnostics scan beyond the former 100-file cap with bounded concurrency", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-workspace-files-"));
  await Promise.all(Array.from(
    { length: 101 },
    (_, index) => writeFile(join(cwd, `source-${index}.ts`), "const value = 1;\n"),
  ));
  const fake = new FakeClient(join(cwd, "source-0.ts"));
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
  );

  try {
    const diagnostics = await manager.diagnostics("workspace");
    assert.equal(diagnostics.length, 303);
    assert.equal(fake.syncCount, 101);
    assert.ok(fake.maxActiveWaits <= 8);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace traversal continues beyond the former 5,000-entry cap", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-workspace-entries-"));
  for (let directory = 0; directory < 50; directory++) {
    const path = join(cwd, `fixtures-${directory}`);
    await mkdir(path);
    await Promise.all(Array.from(
      { length: 100 },
      (_, index) => writeFile(join(path, `entry-${index}.txt`), "fixture\n"),
    ));
  }
  const source = join(cwd, "source.ts");
  await writeFile(source, "const value = 1;\n");
  const fake = new FakeClient(source);
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
  );

  try {
    assert.equal((await manager.diagnostics("workspace")).length, 3);
    assert.equal(fake.syncCount, 1);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("doctor statuses resolve available and missing executables without starting clients", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-status-"));
  const executable = join(cwd, "language-server");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  let clients = 0;
  const manager = new LspManager([
    { extensions: [".ok"], languageIds: { ".ok": "test" }, command: [executable] },
    { extensions: [".missing"], languageIds: { ".missing": "test" }, command: ["definitely-missing-language-server"] },
  ], cwd, () => {
    clients++;
    throw new Error("doctor must not start clients");
  });

  try {
    assert.deepEqual(await manager.statuses(), [
      { extensions: [".ok"], executable, available: true, running: false },
      { extensions: [".missing"], executable: "definitely-missing-language-server", available: false, running: false },
    ]);
    assert.equal(clients, 0);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("filesystem deny rules prevent LSP file synchronization", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-policy-"));
  const source = join(cwd, "secret.ts");
  await writeFile(source, "const secret = 1;\n");
  let clients = 0;
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => { clients++; throw new Error("should not start"); },
    { filesystem: { rules: [{ path: "secret.ts", access: "deny" }] }, sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } } },
  );

  try {
    await assert.rejects(manager.sync(source), /LSP read access is not permitted/);
    assert.equal(clients, 0);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("navigation omits destinations denied by workspace policy", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-navigation-policy-"));
  const source = join(cwd, "source.ts");
  const denied = join(cwd, "secret.ts");
  await writeFile(source, "const value = 1;\n");
  await writeFile(denied, "const secret = 1;\n");
  const fake = new FakeClient(denied);
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
    { filesystem: { rules: [{ path: "secret.ts", access: "deny" }] }, sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } } },
  );

  try {
    assert.deepEqual(await manager.navigate("definition", source, 1, 1), []);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});


test("idle timeout shuts down and removes a client, then the next use starts a replacement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-idle-"));
  const source = join(cwd, "source.ts");
  await writeFile(source, "const value = 1;\n");
  const clients: FakeClient[] = [];
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => {
      const client = new FakeClient(source, clients.length === 0 ? 30 : 0);
      clients.push(client);
      return client as unknown as LspClient;
    },
    undefined,
    0.0002,
  );

  try {
    await manager.sync(source);
    assert.equal(clients.length, 1);
    assert.equal((await manager.statuses())[0]?.running, true);

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(clients[0]?.shutdownCount, 1);
    assert.equal((await manager.statuses())[0]?.running, false);

    const restarted = manager.sync(source);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(clients.length, 1);
    await restarted;
    assert.equal(clients.length, 2);
    assert.equal(clients[1]?.syncCount, 1);
  } finally {
    await manager.shutdown();
    assert.equal(clients[1]?.shutdownCount, 1);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("zero idle timeout keeps the client until session shutdown", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-idle-disabled-"));
  const source = join(cwd, "source.ts");
  await writeFile(source, "const value = 1;\n");
  const client = new FakeClient(source);
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => client as unknown as LspClient,
    undefined,
    0,
  );

  try {
    await manager.sync(source);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(client.shutdownCount, 0);
  } finally {
    await manager.shutdown();
    assert.equal(client.shutdownCount, 1);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unsupported extensions fail without starting a client", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-unsupported-"));
  const source = join(cwd, "source.go");
  await writeFile(source, "package main\n");
  let clients = 0;
  const manager = new LspManager([{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }], cwd, () => {
    clients++;
    throw new Error("should not start");
  });

  try {
    await assert.rejects(manager.sync(source), /No language server configured/);
    assert.equal(clients, 0);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});
