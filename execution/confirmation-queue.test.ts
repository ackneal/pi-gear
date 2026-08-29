import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationQueue } from "./confirmation-queue.ts";

test("one queue serializes confirmations from independent policy systems", async () => {
  const confirmationQueue = new ConfirmationQueue();
  const started: string[] = [];
  const releases = new Map<string, () => void>();
  const confirm = (name: string) => confirmationQueue.run(async () => {
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
