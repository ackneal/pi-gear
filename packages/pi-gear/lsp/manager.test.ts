import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { LspClient } from "./client.ts";
import { LspManager } from "./manager.ts";
import { formatDiagnostics, normalizeDiagnostics } from "./normalize.ts";
import type { DiagnosticSeverity, NormalizedDiagnostic } from "./types.ts";

const exec = promisify(execFile);

const workspaceInventory = (workspace: readonly string[], dirty: readonly string[] = workspace) => ({
  initialize: async () => undefined,
  files: async () => workspace.map((relativePath) => ({ relativePath })),
  dirtyFiles: async () => dirty.map((relativePath) => ({ relativePath })),
  onChange: () => () => undefined,
}) as never;

class FakeClient {
  syncCount = 0;
  shutdownCount = 0;
  lastNavigation: unknown;
  running = false;
  activeWaits = 0;
  maxActiveWaits = 0;
  private readonly target: string;
  private readonly shutdownGate: Promise<void> | undefined;
  constructor(target: string, shutdownGate?: Promise<void>) {
    this.target = target;
    this.shutdownGate = shutdownGate;
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
    await this.shutdownGate;
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
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
    undefined,
    15,
    undefined,
    workspaceInventory(["changed.ts", "clean.ts"], ["changed.ts"]),
  );

  try {
    assert.deepEqual((await manager.diagnostics("changed")).map(({ path }) => path), ["changed.ts", "changed.ts", "changed.ts"]);
    fake.maxActiveWaits = 0;
    assert.deepEqual((await manager.diagnostics("workspace")).map(({ path }) => path), [
      "changed.ts", "changed.ts", "changed.ts", "clean.ts", "clean.ts", "clean.ts",
    ]);
    assert.equal(fake.maxActiveWaits, 2);
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
    undefined,
    15,
    undefined,
    workspaceInventory(Array.from({ length: 101 }, (_, index) => `source-${index}.ts`)),
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

test("Git workspace diagnostics include tracked and untracked files while honoring standard ignore rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-workspace-gitignore-"));
  await writeFile(join(cwd, ".gitignore"), "generated/\n");
  await writeFile(join(cwd, "tracked.py"), "tracked = True\n");
  await writeFile(join(cwd, "untracked.py"), "untracked = True\n");
  await mkdir(join(cwd, "generated"));
  await writeFile(join(cwd, "generated", "ignored.py"), "ignored = True\n");
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["add", ".gitignore", "tracked.py"], { cwd });
  const fake = new FakeClient(join(cwd, "tracked.py"));
  const manager = new LspManager(
    [{ extensions: [".py"], languageIds: { ".py": "python" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
    undefined,
    15,
    undefined,
    workspaceInventory(["tracked.py", "untracked.py"]),
  );

  try {
    assert.equal((await manager.diagnostics("workspace")).length, 6);
    assert.equal(fake.syncCount, 2);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("non-Git workspace diagnostics skip dependency and Python virtual-environment directories", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-workspace-excludes-"));
  await writeFile(join(cwd, "source.py"), "value: str = 1\n");
  for (const directory of [".venv", "venv", "node_modules", "target", "vendor", ".git"]) {
    await mkdir(join(cwd, directory));
    await writeFile(join(cwd, directory, "ignored.py"), "value: str = 1\n");
  }
  const fake = new FakeClient(join(cwd, "source.py"));
  const manager = new LspManager(
    [{ extensions: [".py"], languageIds: { ".py": "python" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
    undefined,
    15,
    undefined,
    workspaceInventory(["source.py"]),
  );

  try {
    assert.equal((await manager.diagnostics("workspace")).length, 3);
    assert.equal(fake.syncCount, 1);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shared watcher trusts WorkspaceSearch filtering and only checks supported extensions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-watcher-git-"));
  await writeFile(join(cwd, ".gitignore"), "ignored/\ntracked.py\n");
  await writeFile(join(cwd, "tracked.py"), "tracked = True\n");
  await writeFile(join(cwd, "untracked.py"), "untracked = True\n");
  await writeFile(join(cwd, "unsupported.txt"), "ignored by extension\n");
  await mkdir(join(cwd, "ignored"));
  await writeFile(join(cwd, "ignored", "source.py"), "ignored = True\n");
  await exec("git", ["init", "-q"], { cwd });
  await exec("git", ["add", ".gitignore"], { cwd });
  await exec("git", ["add", "--force", "tracked.py"], { cwd });
  const manager = new LspManager(
    [{ extensions: [".py"], languageIds: { ".py": "python" }, command: ["server"] }],
    cwd,
  );
  const synced: string[] = [];
  manager.sync = async (path) => { synced.push(path); return []; };
  const schedule = (manager as unknown as { scheduleWatcherSync(path: string): void }).scheduleWatcherSync.bind(manager);
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
  process.on("unhandledRejection", onUnhandled);

  try {
    for (const path of ["tracked.py", "untracked.py", "ignored/source.py", "unsupported.txt"]) schedule(path);
    await new Promise((resolveResult) => setTimeout(resolveResult, 250));

    assert.deepEqual(synced.sort(), [
      resolve(cwd, "tracked.py"),
      resolve(cwd, "untracked.py"),
      resolve(cwd, "ignored/source.py"),
    ].sort());
    assert.deepEqual(unhandled, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandled);
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shared watcher does not repeat WorkspaceSearch directory eligibility rules", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-watcher-fallback-"));
  const manager = new LspManager(
    [{ extensions: [".py"], languageIds: { ".py": "python" }, command: ["server"] }],
    cwd,
  );
  const synced: string[] = [];
  manager.sync = async (path) => { synced.push(path); return []; };
  const schedule = (manager as unknown as { scheduleWatcherSync(path: string): void }).scheduleWatcherSync.bind(manager);

  try {
    for (const path of ["source.py", ".venv/source.py", "node_modules/source.py", "target/source.py", "vendor/source.py"]) schedule(path);
    await new Promise((resolveResult) => setTimeout(resolveResult, 200));

    assert.deepEqual(synced.sort(), [
      "source.py",
      ".venv/source.py",
      "node_modules/source.py",
      "target/source.py",
      "vendor/source.py",
    ].map((path) => resolve(cwd, path)).sort());
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("shutdown awaits an already-dispatched shared watcher sync", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-watcher-shutdown-"));
  const manager = new LspManager(
    [{ extensions: [".py"], languageIds: { ".py": "python" }, command: ["server"] }],
    cwd,
  );
  let syncs = 0;
  manager.sync = async () => { syncs++; return []; };
  const schedule = (manager as unknown as { scheduleWatcherSync(path: string): void }).scheduleWatcherSync.bind(manager);

  try {
    schedule("source.py");
    await manager.shutdown();
    await new Promise((resolveResult) => setTimeout(resolveResult, 150));

    assert.equal(syncs, 1);
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
    undefined,
    15,
    undefined,
    workspaceInventory(["source.ts"]),
  );

  try {
    assert.equal((await manager.diagnostics("workspace")).length, 3);
    assert.equal(fake.syncCount, 1);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace search supplies diagnostics inventory and the shared LSP change stream", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-shared-index-"));
  const source = join(cwd, "source.ts");
  await writeFile(source, "const value = 1;\n");
  let listener: ((events: readonly { path: string; kind: "created" | "modified" | "removed" | "rescan" }[]) => void) | undefined;
  let unsubscribed = false;
  const workspaceIndex = {
    initialize: async () => undefined,
    files: async () => [{ relativePath: "source.ts" }],
    dirtyFiles: async () => [{ relativePath: "source.ts" }],
    onChange: (next: typeof listener) => { listener = next; return () => { unsubscribed = true; }; },
  } as never;
  const fake = new FakeClient(source);
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
    undefined,
    15,
    undefined,
    workspaceIndex,
  );

  try {
    assert.equal((await manager.diagnostics("workspace")).length, 3);
    assert.equal((await manager.diagnostics("changed")).length, 3);
    manager.startWatching();
    listener?.([{ path: source, kind: "modified" }]);
    await new Promise((resolveResult) => setTimeout(resolveResult, 20));
    assert.equal(fake.syncCount, 3);
  } finally {
    await manager.shutdown();
    assert.equal(unsubscribed, true);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("workspace rescan coalesces overlapping requests with bounded concurrency", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-rescan-"));
  const supported = Array.from({ length: 10 }, (_, index) => `source-${index}.ts`);
  await Promise.all([
    ...supported.map((path) => writeFile(join(cwd, path), "const value = 1;\n")),
    writeFile(join(cwd, "notes.txt"), "ignored\n"),
  ]);
  let listener: ((events: readonly { path: string; kind: "rescan" }[]) => void) | undefined;
  const workspaceIndex = {
    files: async () => [...supported, "notes.txt"].map((relativePath) => ({ relativePath })),
    dirtyFiles: async () => [],
    onChange: (next: typeof listener) => { listener = next; return () => undefined; },
  } as never;
  const fake = new FakeClient(join(cwd, supported[0]!));
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
    undefined,
    15,
    undefined,
    workspaceIndex,
  );

  try {
    manager.startWatching();
    listener?.([{ path: cwd, kind: "rescan" }]);
    listener?.([{ path: cwd, kind: "rescan" }]);
    listener?.([{ path: cwd, kind: "rescan" }]);
    const expectedSyncs = supported.length * 2;
    for (let attempt = 0; attempt < 50 && fake.syncCount < expectedSyncs; attempt++) {
      await new Promise((resolveResult) => setTimeout(resolveResult, 5));
    }
    assert.equal(fake.syncCount, expectedSyncs);
    assert.ok(fake.maxActiveWaits <= 8);
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


test("idle timeout shuts down and removes a client, then the next use starts a replacement", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-idle-"));
  const source = join(cwd, "source.ts");
  await writeFile(source, "const value = 1;\n");
  let releaseShutdown!: () => void;
  const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
  const clients: FakeClient[] = [];
  const manager = new LspManager(
    [{ extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    cwd,
    () => {
      const client = new FakeClient(source, clients.length === 0 ? shutdownGate : undefined);
      client.waitForDiagnostics = async () => {};
      clients.push(client);
      return client as unknown as LspClient;
    },
    undefined,
    0.0002,
  );

  try {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    await manager.sync(source);
    assert.equal(clients.length, 1);
    assert.equal((await manager.statuses())[0]?.running, true);

    t.mock.timers.tick(12);
    assert.equal(clients[0]?.shutdownCount, 1);
    assert.equal((await manager.statuses())[0]?.running, false);

    const restarted = manager.sync(source);
    await Promise.resolve();
    assert.equal(clients.length, 1);

    releaseShutdown();
    await restarted;
    assert.equal(clients.length, 2);
    assert.equal(clients[1]?.syncCount, 1);
  } finally {
    releaseShutdown();
    await manager.shutdown();
    if (clients[1] !== undefined) assert.equal(clients[1].shutdownCount, 1);
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
