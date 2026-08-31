import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, Socket } from "node:net";
import test from "node:test";
import type { FileFinderApi, InitOptions } from "@ff-labs/fff-node";
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

test("request validation rejects malformed protocol objects", () => {
  for (const value of [null, 42, {}, [], { event: 123 }, { id: null, method: "status" }, { id: 1, method: 123 }]) {
    assert.equal(isFffRequest(value), false);
  }
  assert.equal(isFffRequest({ id: 1, method: "status" }), true);
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
    for (const value of [null, 42, {}, [], { event: 123 }, { id: null }, { id: 1, method: 123 }]) {
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

test("sidecar startup rejects spawn errors and removes its temporary directory", async () => {
  const before = new Set((await readdir(tmpdir())).filter((name) => name.startsWith("pi-gear-fff-")));
  const basePath = await mkdtemp(join(tmpdir(), "pi-gear-spawn-base-"));
  try {
    await assert.rejects(
      FffSidecar.start(basePath, { nodePath: "/definitely/not/a/real/node", startupTimeoutMs: 200 }),
      /FFF sidecar failed to start.*ENOENT/,
    );
    const after = (await readdir(tmpdir())).filter((name) => name.startsWith("pi-gear-fff-") && !before.has(name));
    assert.deepEqual(after, []);
  } finally {
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
