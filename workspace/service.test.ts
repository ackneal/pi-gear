import assert from "node:assert/strict";
import test from "node:test";
import { FilesystemAccess } from "../execution/filesystem/access.ts";
import type { FffClient } from "../lifecycle/fff-client.ts";
import { WorkspaceSearch } from "./service.ts";

const policy = {
  version: 1 as const,
  filesystem: { rules: [] },
  sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
};

const access = () => new FilesystemAccess("/workspace", {
  loadConfig: async () => policy,
});

test("workspace search shares the FFF client and tracks only a subsequently used result", async () => {
  const calls: Array<[string, unknown]> = [];
  const client = {
    request: async (method: string, params?: unknown) => {
      calls.push([method, params]);
      if (method === "fileSearch") {
        return {
          items: [{ relativePath: "source.ts" }],
          scores: [],
          totalMatched: 1,
          totalFiles: 1,
        };
      }
      if (method === "status") {
        return {
          progress: {
            scannedFilesCount: 1,
            isScanning: false,
            isWatcherReady: true,
            isWarmupComplete: true,
          },
          health: { version: "0.10.5" },
        };
      }
      return true;
    },
  } as unknown as FffClient;
  const search = new WorkspaceSearch("/workspace", access(), client);

  await search.fileSearch("src");
  search.recordFocus("other.ts");
  search.recordFocus("source.ts");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls.find(([method]) => method === "trackQuery")?.[1], {
    query: "src",
    selectedFilePath: "/workspace/source.ts",
  });
  assert.equal((await search.status()).state, "ready");
});

test("workspace status uses the installed FFF package version when health is unavailable", async () => {
  const cases = [
    {
      name: "health omits its version",
      request: async () => ({
        progress: { scannedFilesCount: 1, isScanning: false, isWatcherReady: true, isWarmupComplete: true },
        health: {},
      }),
      state: "ready",
    },
    {
      name: "status request fails",
      request: async () => { throw new Error("disconnected"); },
      state: "error",
    },
  ] as const;

  for (const fixture of cases) {
    const search = new WorkspaceSearch("/workspace", access(), {
      request: fixture.request,
      subscribe: async () => async () => undefined,
    } as unknown as FffClient);

    const status = await search.status();
    assert.equal(status.version, "0.10.5", fixture.name);
    assert.equal(status.state, fixture.state, fixture.name);
  }
});

test("onChange has one pending subscription and releases it when listeners disappear", async () => {
  let resolveSubscription!: (unsubscribe: () => Promise<void>) => void;
  let subscribeCalls = 0;
  let unsubscribeCalls = 0;
  const client = {
    subscribe: async () => {
      subscribeCalls += 1;
      return await new Promise<() => Promise<void>>((resolve) => {
        resolveSubscription = resolve;
      });
    },
  } as unknown as FffClient;
  const search = new WorkspaceSearch("/workspace", access(), client);

  const removeFirst = search.onChange(() => undefined);
  const removeSecond = search.onChange(() => undefined);
  assert.equal(subscribeCalls, 1);

  removeFirst();
  removeSecond();
  resolveSubscription(async () => {
    unsubscribeCalls += 1;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(subscribeCalls, 1);
  assert.equal(unsubscribeCalls, 1);
});

test("onChange retries a transient first subscription failure for one listener", async () => {
  let subscribeCalls = 0;
  const client = {
    subscribe: async () => {
      subscribeCalls++;
      if (subscribeCalls === 1) throw new Error("temporary failure");
      return async () => undefined;
    },
  } as unknown as FffClient;
  const search = new WorkspaceSearch("/workspace", access(), client);

  search.onChange(() => undefined);
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.equal(subscribeCalls, 2);
});

test("onChange cancels scheduled retries when listeners disappear", async () => {
  let subscribeCalls = 0;
  const client = {
    subscribe: async () => {
      subscribeCalls++;
      throw new Error("temporary failure");
    },
  } as unknown as FffClient;
  const search = new WorkspaceSearch("/workspace", access(), client);

  const remove = search.onChange(() => undefined);
  await new Promise<void>((resolve) => setImmediate(resolve));
  remove();
  await new Promise<void>((resolve) => setTimeout(resolve, 40));

  assert.equal(subscribeCalls, 1);
});
