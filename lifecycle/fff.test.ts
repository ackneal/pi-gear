import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import test from "node:test";
import type { FileFinderApi, InitOptions } from "@ff-labs/fff-node";
import { FffClient } from "./fff-client.ts";
import { startFffSidecar, fffFinderOptions } from "./fff-sidecar.ts";
import { resolveFffRoot } from "./fff.ts";

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
