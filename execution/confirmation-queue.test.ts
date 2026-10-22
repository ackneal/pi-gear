import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationQueue } from "./confirmation-queue.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const promptly = async (result: Promise<boolean>) => {
  assert.equal(await Promise.race([result, tick().then(() => "pending")]), false);
};

for (const cancellation of ["reset", "active abort", "queued abort"] as const) {
  test(`${cancellation} completes cancelled requests without releasing active UI ownership`, async () => {
    const queue = new ConfirmationQueue();
    const activeCaller = new AbortController();
    const queuedCaller = new AbortController();
    const started: string[] = [];
    let activeSignal!: AbortSignal;
    let release!: (allowed: boolean) => void;
    const active = queue.confirm((signal) => {
      activeSignal = signal;
      started.push("active");
      return new Promise<boolean>((resolve) => { release = resolve; });
    }, activeCaller.signal);
    const queued = queue.confirm(async () => {
      started.push("queued");
      return true;
    }, queuedCaller.signal);
    await tick();

    try {
      if (cancellation === "reset") queue.reset();
      else if (cancellation === "active abort") activeCaller.abort();
      else queuedCaller.abort();
      assert.equal(activeSignal.aborted, cancellation !== "queued abort");
      if (cancellation !== "queued abort") await promptly(active);
      if (cancellation !== "active abort") await promptly(queued);

      const current = queue.confirm(async () => {
        started.push("current");
        return true;
      });
      await tick();
      assert.deepEqual(started, ["active"]);
      release(true);
      assert.equal(await active, cancellation === "queued abort");
      assert.equal(await queued, cancellation === "active abort");
      assert.equal(await current, true);
      assert.deepEqual(started, cancellation === "active abort"
        ? ["active", "queued", "current"] : ["active", "current"]);
    } finally {
      release(true);
    }
  });
}

for (const failure of ["reject", "throw", "reject after abort"] as const) {
  test(`${failure} does not poison the queue`, async () => {
    const queue = new ConfirmationQueue();
    const caller = new AbortController();
    let reject!: (error: Error) => void;
    const error = new Error("dialog failed");
    const failed = queue.confirm(() => {
      if (failure === "throw") throw error;
      return new Promise<boolean>((_resolve, fail) => { reject = fail; });
    }, caller.signal);
    const checked = failure === "reject after abort"
      ? failed.then((allowed) => assert.equal(allowed, false))
      : assert.rejects(failed, error);
    await tick();
    if (failure === "reject after abort") caller.abort();
    if (failure !== "throw") reject(error);
    await checked;
    assert.equal(await queue.confirm(async () => true), true);
  });
}

test("already aborted requests never show and concurrent callbacks serialize", async () => {
  const queue = new ConfirmationQueue();
  const caller = new AbortController();
  caller.abort();
  assert.equal(await queue.confirm(async () => assert.fail("aborted dialog shown"), caller.signal), false);
  let active = 0;
  let maximum = 0;
  const results = await Promise.all(Array.from({ length: 10 }, () => queue.confirm(async () => {
    maximum = Math.max(maximum, ++active);
    await tick();
    active--;
    return true;
  })));
  assert.equal(maximum, 1);
  assert.deepEqual(results, Array(10).fill(true));
});
