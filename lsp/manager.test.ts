import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import type { LspClient } from "./client.ts";
import { LspManager } from "./manager.ts";
import { formatDiagnostics, normalizeDiagnostics } from "./normalize.ts";

const exec = promisify(execFile);

class FakeClient {
  syncCount = 0;
  shutdownCount = 0;
  lastNavigation: unknown;
  private readonly target: string;
  constructor(target: string) { this.target = target; }
  diagnosticsRevision(): number { return 0; }
  async sync(): Promise<void> { this.syncCount++; }
  async waitForDiagnostics(): Promise<void> {}
  diagnosticsFor() {
    return [
      { range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }, severity: 1, code: 10, message: " first\nerror " },
      { range: { start: { line: 4, character: 5 }, end: { line: 4, character: 6 } }, severity: 2, message: "warning" },
      { range: { start: { line: 7, character: 8 }, end: { line: 7, character: 9 } }, severity: 3, message: "ignore" },
    ];
  }
  async navigate(method: string, path: string, position: unknown): Promise<unknown> {
    this.lastNavigation = { method, path, position };
    return [{
      uri: pathToFileURL(this.target).href,
      range: { start: { line: 8, character: 9 }, end: { line: 8, character: 10 } },
    }];
  }
  async shutdown(): Promise<void> { this.shutdownCount++; }
}

test("manager matches configured extensions, reuses clients, normalizes diagnostics, and maps navigation positions", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-manager-"));
  const source = join(cwd, "source.ts");
  await writeFile(source, "const value = 1;\n");
  const fake = new FakeClient(source);
  const manager = new LspManager(
    [{ extensions: [".ts", ".tsx"], command: ["server"] }],
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
    assert.equal(formatDiagnostics(first), "source.ts:2:3 error [10]: first error\nsource.ts:5:6 warning: warning");

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

test("diagnostic normalization keeps only errors and warnings", () => {
  const diagnostics = normalizeDiagnostics("/workspace/a.ts", "/workspace", [
    { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 1, message: "error" },
    { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, severity: 2, message: "warning" },
    { range: { start: { line: 2, character: 2 }, end: { line: 2, character: 3 } }, severity: 4, message: "hint" },
  ]);
  assert.deepEqual(diagnostics.map(({ severity }) => severity), ["error", "warning"]);
});

test("diagnostics changed scope follows Git while workspace and non-Git fallback scan configured files", async () => {
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
  const manager = new LspManager([{ extensions: [".ts"], command: ["server"] }], cwd, () => fake as unknown as LspClient);

  try {
    assert.deepEqual((await manager.diagnostics("changed")).map(({ path }) => path), ["changed.ts", "changed.ts"]);
    assert.deepEqual((await manager.diagnostics("workspace")).map(({ path }) => path), ["changed.ts", "changed.ts", "clean.ts", "clean.ts"]);
    await rm(join(cwd, ".git"), { recursive: true, force: true });
    assert.equal((await manager.diagnostics("changed")).length, 4);
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
    { extensions: [".ok"], command: [executable] },
    { extensions: [".missing"], command: ["definitely-missing-language-server"] },
  ], cwd, () => {
    clients++;
    throw new Error("doctor must not start clients");
  });

  try {
    assert.deepEqual(await manager.statuses(), [
      { extensions: [".ok"], executable, available: true },
      { extensions: [".missing"], executable: "definitely-missing-language-server", available: false, reason: "not found" },
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
    [{ extensions: [".ts"], command: ["server"] }],
    cwd,
    () => { clients++; throw new Error("should not start"); },
    { filesystem: { rules: [{ path: "secret.ts", access: "deny" }] }, network: { rules: [] } },
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
    [{ extensions: [".ts"], command: ["server"] }],
    cwd,
    () => fake as unknown as LspClient,
    { filesystem: { rules: [{ path: "secret.ts", access: "deny" }] }, network: { rules: [] } },
  );

  try {
    assert.deepEqual(await manager.navigate("definition", source, 1, 1), []);
  } finally {
    await manager.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unsupported extensions fail without starting a client", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-unsupported-"));
  const source = join(cwd, "source.go");
  await writeFile(source, "package main\n");
  let clients = 0;
  const manager = new LspManager([{ extensions: [".ts"], command: ["server"] }], cwd, () => {
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
