import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket } from "node:net";
import test from "node:test";
import type { FileFinderApi, InitOptions } from "@ff-labs/fff-bun";
import { FffClient } from "./fff-client.ts";
import { startFffSidecar, fffFinderOptions } from "./fff-sidecar.ts";
import { FffSidecar, resolveFffRoot } from "./fff.ts";
import { isFffMessage, isFffRequest } from "./fff-protocol.ts";

async function temporarySocket(name: string): Promise<{ dir: string; path: string }> {
  const dir = await mkdtemp(join(tmpdir(), name));
  return { dir, path: join(dir, "test.sock") };
}

test("FFF root canonicalizes macOS temporary-directory aliases", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-gear-fff-root-"));
  try {
    const root = await resolveFffRoot(temporary);
    assert.equal(root, await import("node:fs/promises").then(({ realpath }) => realpath(temporary)));
    if (process.platform === "darwin" && temporary.startsWith("/var/")) assert.match(root, /^\/private\/var\//);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("finder options enable ephemeral session defaults without database paths", () => {
  const options = fffFinderOptions("/workspace");
  assert.deepEqual(options, {
    basePath: "/workspace",
    disableContentIndexing: false,
    disableMmapCache: false,
    disableWatch: false,
    aiMode: true,
    followSymlinks: false,
    enableFsRootScanning: false,
    enableHomeDirScanning: false,
  });
  assert.equal("frecencyDbPath" in options, false);
  assert.equal("historyDbPath" in options, false);
});

test("client safely handles unobserved transport and malformed JSON errors", () => {
  const socket = new Socket();
  const client = new FffClient(socket);

  assert.doesNotThrow(() => socket.emit("data", "not JSON\n"));
  assert.doesNotThrow(() => socket.emit("error", new Error("socket failed")));
  client.close();
});

test("client rejects valid JSON that is not a protocol response or event", () => {
  const malformed = [
    null,
    [],
    {},
    { id: "1", result: true },
    { id: 1 },
    { id: 1, result: true, error: "both" },
    { id: 1, error: 42 },
    { event: "watch", subscriptionId: 1, data: null },
    { event: "watch", subscriptionId: 1, data: [{ path: "/x", kind: "unknown" }] },
  ];

  for (const value of malformed) {
    assert.equal(isFffMessage(value), false);
    const socket = new Socket();
    const client = new FffClient(socket);
    const errors: Error[] = [];
    client.on("error", (error) => errors.push(error));

    assert.doesNotThrow(() => socket.emit("data", `${JSON.stringify(value)}\n`));
    assert.match(errors[0]?.message ?? "", /Invalid FFF sidecar message/);
    client.close();
  }
});

test("FFF request validation accepts every supported method contract", () => {
  const requests = [
    { id: 1, method: "status" },
    { id: 1, method: "fileSearch", params: { query: "src", options: { pageSize: 20 } } },
    { id: 1, method: "glob", params: { pattern: "**/*.ts", options: {
      maxThreads: 2,
      currentFile: "src/a.ts",
      pageIndex: 1,
      pageSize: 20,
    } } },
    { id: 1, method: "mixedSearch", params: { query: "src", options: { maxThreads: 2 } } },
    { id: 1, method: "grep", params: { query: "TODO", options: { mode: "plain", smartCase: true } } },
    { id: 1, method: "multiGrep", params: { patterns: ["TODO", "FIXME"], constraints: "*.ts" } },
    { id: 1, method: "files", params: { pageSize: 100 } },
    { id: 1, method: "dirtyFiles" },
    { id: 1, method: "trackQuery", params: { query: "src", selectedFilePath: "/workspace/src.ts" } },
    { id: 1, method: "subscribe", params: { pattern: "**/*.ts", options: { ignore: ["dist/**"] } } },
    { id: 1, method: "unsubscribe", params: { subscriptionId: 2 } },
    { id: 1, method: "shutdown" },
  ];

  for (const request of requests) assert.equal(isFffRequest(request), true, request.method);
});

test("FFF request validation rejects invalid envelopes and method payloads", () => {
  const invalid = [
    ["null", null],
    ["primitive", 42],
    ["array", []],
    ["missing id", { method: "status" }],
    ["invalid id", { id: null, method: "status" }],
    ["missing method", { id: 1 }],
    ["invalid method type", { id: 1, method: 123 }],
    ["unsupported method", { id: 1, method: "unknown" }],
    ["status params", { id: 1, method: "status", params: {} }],
    ["fileSearch query", { id: 1, method: "fileSearch", params: { query: 42 } }],
    ["glob pattern", { id: 1, method: "glob", params: { pattern: null } }],
    ["glob combo boost", { id: 1, method: "glob", params: { pattern: "**/*", options: { comboBoostMultiplier: 2 } } }],
    ["glob combo count", { id: 1, method: "glob", params: { pattern: "**/*", options: { minComboCount: 3 } } }],
    ["mixedSearch options", { id: 1, method: "mixedSearch", params: { query: "src", options: [] } }],
    ["grep option", { id: 1, method: "grep", params: { query: "x", options: { smartCase: "yes" } } }],
    ["multiGrep patterns", { id: 1, method: "multiGrep", params: { patterns: ["x", 2] } }],
    ["files pageSize", { id: 1, method: "files", params: { pageSize: "large" } }],
    ["dirtyFiles params", { id: 1, method: "dirtyFiles", params: [] }],
    ["trackQuery params", { id: 1, method: "trackQuery", params: null }],
    ["subscribe ignore", { id: 1, method: "subscribe", params: { options: { ignore: "dist" } } }],
    ["unsubscribe id", { id: 1, method: "unsubscribe", params: { subscriptionId: "invalid" } }],
    ["shutdown params", { id: 1, method: "shutdown", params: {} }],
  ] as const;

  for (const [name, request] of invalid) assert.equal(isFffRequest(request), false, name);
});

test("client correlates concurrent out-of-order responses and delivers events", async (t) => {
  const temporary = await temporarySocket("pi-gear-client-");
  const server = createServer((socket) => {
    let input = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      input += chunk;
      const requests = input.trim().split("\n").map((line) => JSON.parse(line) as { id: number });
      if (requests.length !== 2) return;
      socket.write(`${JSON.stringify({ event: "watch", subscriptionId: 7, data: [{ path: "/x", kind: "modified" }] })}\n`);
      socket.write(`${JSON.stringify({ id: requests[1]!.id, result: "second" })}\n${JSON.stringify({ id: requests[0]!.id, result: "first" })}\n`);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(temporary.path, () => { server.off("error", reject); resolve(); });
    });
  } catch (error) {
    await rm(temporary.dir, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Unix sockets unavailable in test harness"); return; }
    throw error;
  }
  const client = await FffClient.connect(temporary.path);
  const events: unknown[] = [];
  client.on("watch", (id, batch) => events.push([id, batch]));
  try {
    const [first, second] = await Promise.all([client.request("status"), client.request("status")]);
    assert.deepEqual([first, second], ["first", "second"]);
    assert.equal(events.length, 1);
  } finally {
    client.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(temporary.dir, { recursive: true, force: true });
  }
});

test("sidecar closes malformed request connections without affecting valid clients", async (t) => {
  const temporary = await temporarySocket("pi-gear-malformed-requests-");
  const finder = {
    getScanProgress: () => ({ ok: true, value: {} }),
    healthCheck: () => ({ ok: true, value: {} }),
    destroy: () => undefined,
  } as unknown as FileFinderApi;
  let daemon;
  try {
    daemon = await startFffSidecar({
      socketPath: temporary.path,
      basePath: "/workspace",
      createFinder: () => ({ ok: true, value: finder }),
    });
  } catch (error) {
    await rm(temporary.dir, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Unix sockets unavailable in test harness"); return; }
    throw error;
  }

  try {
    for (const value of [
      null,
      42,
      {},
      [],
      { event: 123 },
      { id: null },
      { id: 1, method: 123 },
      { id: 1, method: "fileSearch", params: { query: 42 } },
      { id: 1, method: "trackQuery", params: null },
      { id: 1, method: "unsubscribe", params: { subscriptionId: "invalid" } },
    ]) {
      const socket = await new Promise<Socket>((resolve, reject) => {
        const connected = new Socket();
        connected.once("error", reject);
        connected.connect(temporary.path, () => { connected.off("error", reject); resolve(connected); });
      });
      const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
      socket.write(`${JSON.stringify(value)}\n`);
      await closed;
    }

    const client = await FffClient.connect(temporary.path);
    assert.equal(typeof await client.request("status"), "object");
    client.close();
  } finally {
    await daemon.close();
    await rm(temporary.dir, { recursive: true, force: true });
  }
});

test("sidecar startup rejects bad Bun executable errors and removes its temporary directory", async () => {
  const sidecarTempName = /^pi-gear-fff-[A-Za-z0-9]+$/;
  const before = new Set((await readdir(tmpdir())).filter((name) => sidecarTempName.test(name)));
  const basePath = await mkdtemp(join(tmpdir(), "pi-gear-spawn-base-"));
  try {
    await assert.rejects(
      FffSidecar.start(basePath, { bunPath: "/definitely/not/a/real/bun", startupTimeoutMs: 200 }),
      /Bun executable not found/,
    );
    const deadline = Date.now() + 2_000;
    for (;;) {
      const after = (await readdir(tmpdir())).filter((name) => sidecarTempName.test(name) && !before.has(name));
      if (after.length === 0) break;
      if (Date.now() >= deadline) assert.deepEqual(after, []);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    await rm(basePath, { recursive: true, force: true });
  }
});

test("running sidecar child errors fail the client without becoming uncaught", async (t) => {
  const socketProbe = await temporarySocket("pi-gear-sidecar-probe-");
  const probe = createServer();
  try {
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(socketProbe.path, () => { probe.off("error", reject); resolve(); });
    });
  } catch (error) {
    await rm(socketProbe.dir, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Unix sockets unavailable in test harness"); return; }
    throw error;
  }
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  await rm(socketProbe.dir, { recursive: true, force: true });

  const basePath = await mkdtemp(join(tmpdir(), "pi-gear-running-error-"));
  let sidecar: FffSidecar | undefined;
  try {
    sidecar = await FffSidecar.start(basePath);
    const clientError = once(sidecar.client, "error");
    const clientClose = new Promise<void>((resolve) => sidecar!.client.once("close", resolve));
    assert.doesNotThrow(() => sidecar!.child.emit("error", new Error("simulated child failure")));
    assert.match((await clientError)[0].message, /simulated child failure/);
    await clientClose;
  } finally {
    await sidecar?.dispose();
    await sidecar?.dispose();
    await rm(basePath, { recursive: true, force: true });
  }
});

test("sidecar owns subscriptions per socket and cleans them up on disconnect", async (t) => {
  const temporary = await temporarySocket("pi-gear-subscriptions-");
  let unsubscribeCount = 0;
  let resolveUnsubscribed!: () => void;
  const unsubscribed = new Promise<void>((resolve) => { resolveUnsubscribed = resolve; });
  const finder = {
    watch: () => ({
      ok: true,
      value: () => {
        unsubscribeCount++;
        resolveUnsubscribed();
      },
    }),
    destroy: () => undefined,
  } as unknown as FileFinderApi;
  let daemon;
  try {
    daemon = await startFffSidecar({
      socketPath: temporary.path,
      basePath: "/workspace",
      createFinder: () => ({ ok: true, value: finder }),
    });
  } catch (error) {
    await rm(temporary.dir, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Unix sockets unavailable in test harness"); return; }
    throw error;
  }
  const owner = await FffClient.connect(temporary.path);
  const other = await FffClient.connect(temporary.path);
  try {
    const subscribed = await owner.request("subscribe") as { subscriptionId: number };
    await other.request("unsubscribe", { subscriptionId: subscribed.subscriptionId });
    assert.equal(unsubscribeCount, 0);

    owner.close();
    await unsubscribed;
    assert.equal(unsubscribeCount, 1);
  } finally {
    owner.close();
    other.close();
    await daemon.close();
    await rm(temporary.dir, { recursive: true, force: true });
  }
});

test("daemon starts before readiness and gates queries with a bounded wait", async (t) => {
  const temporary = await temporarySocket("pi-gear-daemon-");
  let waited: number | undefined;
  let destroyed = false;
  const finder = {
    waitForIndexReady: async (timeout: number) => { waited = timeout; return { ok: true, value: true }; },
    getScanProgress: () => ({ ok: true, value: { scannedFilesCount: 0, isScanning: true, isWatcherReady: false, isWarmupComplete: false } }),
    healthCheck: () => ({ ok: true, value: { version: "test" } }),
    fileSearch: (query: string) => ({ ok: true, value: { query } }),
    destroy: () => { destroyed = true; },
    get isDestroyed() { return destroyed; },
  } as unknown as FileFinderApi;
  const seen: InitOptions[] = [];
  let daemon;
  try {
    daemon = await startFffSidecar({
      socketPath: temporary.path,
      basePath: "/workspace",
      readyTimeoutMs: 37,
      createFinder: (options) => { seen.push(options); return { ok: true, value: finder }; },
    });
  } catch (error) {
    await rm(temporary.dir, { recursive: true, force: true });
    if ((error as NodeJS.ErrnoException).code === "EPERM") { t.skip("Unix sockets unavailable in test harness"); return; }
    throw error;
  }
  const client = await FffClient.connect(temporary.path);
  try {
    const status = await client.request("status") as { progress: { isScanning: boolean } };
    assert.equal(status.progress.isScanning, true);
    assert.equal(waited, undefined);
    assert.deepEqual(await client.request("fileSearch", { query: "src" }), { query: "src" });
    assert.equal(waited, 37);
    assert.equal(seen.length, 1);
  } finally {
    client.close();
    await daemon.close();
    assert.equal(destroyed, true);
    await rm(temporary.dir, { recursive: true, force: true });
  }
});
