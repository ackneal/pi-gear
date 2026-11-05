import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccessPolicy, FilesystemRule } from "../../config/index.ts";
import { ConfirmationQueue } from "../confirmation-queue.ts";
import { FilesystemAccess } from "./access.ts";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
};

const choices = [
  { name: "Allow", project: false, persistent: false },
  { name: "Always allow", project: false, persistent: true },
  { name: "Allow project", project: true, persistent: false },
  { name: "Always allow project", project: true, persistent: true },
] as const;

type Choice = typeof choices[number];

const fixture = async (t: TestContext, choice: Choice) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-gear-access-abort-")));
  const queue = new ConfirmationQueue();
  const response = deferred<string | undefined>();
  t.after(async () => {
    queue.reset();
    response.resolve(undefined);
    await queue.prompt(async () => undefined, undefined);
    await rm(root, { recursive: true, force: true });
  });

  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const path = join(outside, "file.txt");
  await mkdir(workspace);
  await mkdir(outside);
  await writeFile(path, "content");
  if (choice.project) await mkdir(join(outside, ".git"));

  const pattern = choice.project ? `${outside}/**` : path;
  const selection = choice.name === "Allow project" ? `Allow project (${pattern})` : choice.name;
  const opened = deferred<void>();
  const prompts: string[][] = [];
  const persisted: FilesystemRule[] = [];
  const notifications: Parameters<ExtensionContext["ui"]["notify"]>[] = [];
  const ui = {
    select: ((_title, options) => {
      prompts.push(options);
      opened.resolve();
      return response.promise;
    }) satisfies ExtensionContext["ui"]["select"],
    notify: ((...args) => { notifications.push(args); }) satisfies ExtensionContext["ui"]["notify"],
  };
  const ctx = { hasUI: true, ui } as unknown as ExtensionContext;
  const policy: AccessPolicy = {
    filesystem: { rules: [] },
    sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
  };
  const access = new FilesystemAccess(workspace, {
    confirmationQueue: queue,
    loadConfig: async () => policy,
    tempSource: async () => join(root, "runtime-temp"),
    persistRule: async (rule) => { persisted.push(rule); },
  });
  const authorization = await access.authorize(path, "read");
  assert.equal(authorization.decision, "ask");

  return {
    access, authorization, ctx, path, pattern, selection, opened, response, prompts, persisted, notifications,
    drain: () => queue.prompt(async () => undefined, undefined),
  };
};

// Observe real listener registration so cancellation happens after a caller has
// joined the pending prompt, rather than racing filesystem I/O with a timer.
const observedController = (t: TestContext) => {
  const controller = new AbortController();
  const registered = deferred<void>();
  const signal = controller.signal;
  const addEventListener = signal.addEventListener;
  t.mock.method(signal, "addEventListener", (...args: Parameters<AbortSignal["addEventListener"]>) => {
    addEventListener.apply(signal, args);
    if (args[0] === "abort") registered.resolve();
  });
  return { controller, registered: registered.promise };
};

for (const choice of choices) {
  for (const timing of ["pre-aborted", "abort after prompt opens"] as const) {
    test(`sole filesystem caller: ${timing}, late ${choice.name} has no effects`, { timeout: 5_000 }, async (t) => {
      const f = await fixture(t, choice);
      const controller = new AbortController();
      if (timing === "pre-aborted") controller.abort();

      const pending = f.access.request(f.path, "read", "read", f.ctx, controller.signal);
      if (timing === "abort after prompt opens") {
        await f.opened.promise;
        assert.equal(f.prompts.length, 1);
        assert.ok(f.prompts[0]?.includes(f.selection));
        controller.abort();
      }
      assert.deepEqual(await pending, f.authorization);

      // A non-cooperative UI can still return approval after cancellation.
      f.response.resolve(f.selection);
      await f.drain();

      assert.deepEqual({
        prompts: f.prompts.length,
        approvals: f.access.sessionApprovals,
        persisted: f.persisted,
        notifications: f.notifications,
      }, {
        prompts: timing === "pre-aborted" ? 0 : 1,
        approvals: [],
        persisted: [],
        notifications: [],
      });
    });
  }

  for (const timing of ["pre-aborted peer", "abort prompt creator", "abort prompt joiner"] as const) {
    test(`shared filesystem callers: ${timing}, ${choice.name} still approves active caller`, { timeout: 5_000 }, async (t) => {
      const f = await fixture(t, choice);
      const aborted = observedController(t);
      const active = observedController(t);
      const request = (controller: AbortController) =>
        f.access.request(f.path, "read", "read", f.ctx, controller.signal);

      let cancelled: ReturnType<typeof request>;
      let surviving: ReturnType<typeof request>;
      if (timing === "pre-aborted peer") {
        aborted.controller.abort();
        cancelled = request(aborted.controller);
        assert.deepEqual(await cancelled, f.authorization);
        surviving = request(active.controller);
        await f.opened.promise;
        await active.registered;
      } else if (timing === "abort prompt creator") {
        cancelled = request(aborted.controller);
        await f.opened.promise;
        await aborted.registered;
        surviving = request(active.controller);
        await active.registered;
        aborted.controller.abort();
      } else {
        surviving = request(active.controller);
        await f.opened.promise;
        await active.registered;
        cancelled = request(aborted.controller);
        await aborted.registered;
        aborted.controller.abort();
      }
      assert.deepEqual(await cancelled, f.authorization);
      assert.equal(f.prompts.length, 1);
      assert.ok(f.prompts[0]?.includes(f.selection));

      f.response.resolve(f.selection);
      assert.deepEqual(await surviving, { ...f.authorization, decision: "allow" });
      await f.drain();

      const rule = { path: f.pattern, access: "read-only" } as const;
      const scope = choice.project ? "outside-workspace project access" : "outside-workspace access";
      const status = choice.persistent ? "permanently approved" : "approved";
      assert.deepEqual(f.access.sessionApprovals, [{ pattern: f.pattern, access: "read-only" }]);
      assert.deepEqual(f.persisted, choice.persistent ? [rule] : []);
      assert.deepEqual(f.notifications, [[`User ${status} ${scope}: read ${f.pattern}`, "info"]]);
      assert.equal((await f.access.request(f.path, "read", "read", f.ctx)).decision, "allow");
      assert.equal(f.prompts.length, 1);
      assert.equal(f.notifications.length, 1);
      assert.equal(f.persisted.length, choice.persistent ? 1 : 0);
    });
  }
}
