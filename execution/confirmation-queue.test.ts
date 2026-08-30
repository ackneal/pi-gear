import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationQueue } from "./confirmation-queue.ts";

test("one queue serializes confirmations from independent policy systems", async () => {
  const confirmationQueue = new ConfirmationQueue();
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const confirm = (name: string) => confirmationQueue.confirm(async () => {
    started.push(name);
    await new Promise<void>((resolve) => { releases.set(name, resolve); });
    return true;
  });

  const waitForStarted = async (count: number): Promise<void> => {
    while (started.length < count) await new Promise<void>((resolve) => setImmediate(resolve));
  };
  const filesystem = confirm("filesystem");
  const network = confirm("network");
  await waitForStarted(1);
  assert.deepEqual(started, ["filesystem"]);

  releases.get("filesystem")!();
  await filesystem;
  await waitForStarted(2);
  assert.deepEqual(started, ["filesystem", "network"]);

  releases.get("network")!();
  assert.equal(await network, true);
});

test("reset denies active and queued confirmations before the next generation proceeds", async () => {
  const confirmationQueue = new ConfirmationQueue();
  const started: string[] = [];
  let releaseActive!: (allowed: boolean) => void;
  const active = confirmationQueue.confirm(() => {
    started.push("active");
    return new Promise<boolean>((resolve) => { releaseActive = resolve; });
  });
  const stale = confirmationQueue.confirm(async () => {
    started.push("stale");
    return true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  confirmationQueue.reset();
  const current = confirmationQueue.confirm(async () => {
    started.push("current");
    return true;
  });
  releaseActive(true);

  assert.deepEqual(await Promise.all([active, stale, current]), [false, false, true]);
  assert.deepEqual(started, ["active", "current"]);
});
