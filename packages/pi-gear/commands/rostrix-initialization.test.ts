import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Extension, SessionShutdownEvent } from "@earendil-works/pi-coding-agent";
import type { Runtime } from "../../pi-rostrix/src/index.ts";

const runtimeSymbol = Symbol.for("pi.rostrix.runtime");
function currentRuntime(): Runtime | undefined {
  return (globalThis as typeof globalThis & { [runtimeSymbol]?: Runtime })[runtimeSymbol];
}
const root = fileURLToPath(new URL("../", import.meta.url));
const entries = {
  gear: fileURLToPath(new URL("../index.ts", import.meta.url)),
  rostrix: fileURLToPath(new URL("../../pi-rostrix/src/extension.ts", import.meta.url)),
};
const gearTools = ["request_command", "task_state", "researcher", "worker", "reviewer", "subagent_observe", "subagent_cancel"];
const rostrixTools = ["delegate", "task_status", "task_wait", "task_cancel"];

async function shutdown(extension: Extension, reason: SessionShutdownEvent["reason"]): Promise<void> {
  // These shutdown hooks do not consume a session context. Avoid session_start,
  // which would launch Gear's sidecars, and invoke only the loaded hooks.
  const results = await Promise.allSettled(
    [...(extension.handlers.get("session_shutdown") ?? [])].map((handler) =>
      Promise.resolve().then(() => handler({ type: "session_shutdown", reason }))),
  );
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, `Shutdown failed: ${extension.path}`);
}

for (const order of [["gear", "rostrix"], ["rostrix", "gear"]] as const) {
  test(`SDK loader initializes ${order.join(" then ")} with shared runtime and standalone registrations`, async () => {
    const previousChild = process.env.PI_GEAR_CHILD;
    const loaded: Extension[] = [];
    const stopped = new Set<Extension>();
    const stop = async (extension: Extension, reason: SessionShutdownEvent["reason"] = "quit") => {
      stopped.add(extension);
      await shutdown(extension, reason);
    };

    delete process.env.PI_GEAR_CHILD;
    try {
      // Jiti may cache modules between rows; the process-global symbol, not an
      // imported class identity, is the authoritative singleton boundary.
      await currentRuntime()?.dispose();
      assert.equal(currentRuntime(), undefined);
      const loaderUrl = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
      const { loadExtensions } = await import(loaderUrl.href);
      const first = await loadExtensions([entries[order[0]]], root);
      loaded.push(...first.extensions);
      assert.deepEqual(first.errors, []);
      assert.equal(first.extensions.length, 1);
      const runtime = currentRuntime();
      assert.ok(runtime?.isInitialized);

      const second = await loadExtensions([entries[order[1]]], root, undefined, first.runtime);
      loaded.push(...second.extensions);
      assert.deepEqual(second.errors, []);
      assert.equal(second.extensions.length, 1);
      assert.equal(currentRuntime(), runtime);
      const gear = loaded.find((extension) => extension.path === entries.gear)!;
      const rostrix = loaded.find((extension) => extension.path === entries.rostrix)!;
      assert.ok(gear);
      assert.ok(rostrix);
      assert.deepEqual([...gear.tools.keys()].sort(), [...gearTools].sort());
      assert.deepEqual([...rostrix.tools.keys()].sort(), [...rostrixTools].sort());
      for (const name of [...gearTools, ...rostrixTools]) {
        assert.equal(loaded.filter((extension) => extension.tools.has(name)).length, 1, name);
      }
      for (const [name, owner] of [["gear:agents", gear], ["rostrix:agents", rostrix]] as const) {
        assert.ok(owner.commands.has(name), `${name} belongs to ${owner.path}`);
        assert.equal(loaded.filter((extension) => extension.commands.has(name)).length, 1, name);
      }
      for (const id of ["gear:researcher", "gear:worker", "gear:reviewer"]) assert.ok(runtime.getAgent(id), id);

      process.env.PI_GEAR_CHILD = "1";
      const child = await loadExtensions([entries.gear], root);
      loaded.push(...child.extensions);
      assert.deepEqual(child.errors, []);
      assert.equal(child.extensions.length, 1);
      assert.equal(currentRuntime(), runtime);
      assert.equal(child.extensions[0].commands.size, 0);
      for (const name of [...gearTools, ...rostrixTools]) {
        assert.equal(child.extensions[0].tools.has(name), false, `child must not register ${name}`);
      }
      await stop(child.extensions[0]);
      assert.equal(currentRuntime(), runtime, "child shutdown must not dispose its parent's runtime");
      assert.equal(runtime.isInitialized, true);

      await stop(first.extensions[0], "reload");
      await stop(second.extensions[0], "reload");
      assert.equal(currentRuntime(), undefined, "owner shutdown clears the global runtime");
      assert.equal(runtime.isInitialized, false);
      assert.deepEqual(runtime.getAllAgents(), [], "shutdown clears registered profiles");

      delete process.env.PI_GEAR_CHILD;
      const reloaded = await loadExtensions(order.map((name) => entries[name]), root);
      loaded.push(...reloaded.extensions);
      assert.deepEqual(reloaded.errors, []);
      const nextRuntime = currentRuntime();
      assert.ok(nextRuntime?.isInitialized);
      assert.notStrictEqual(nextRuntime, runtime);
      assert.notStrictEqual(nextRuntime.tasks, runtime.tasks);
      assert.deepEqual(reloaded.extensions.flatMap((extension: Extension) => [...extension.tools.keys()]).sort(), [...gearTools, ...rostrixTools].sort());
      assert.deepEqual(reloaded.extensions.flatMap((extension: Extension) => [...extension.commands.keys()]).sort(), ["gear:agents", "gear:doctor", "gear:plan", "gear:subagent-model", "rostrix:agents"]);
    } finally {
      try {
        const cleanup = await Promise.allSettled(loaded.filter((extension) => !stopped.has(extension)).map((extension) => stop(extension)));
        await currentRuntime()?.dispose();
        const errors = cleanup.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, "Extension cleanup failed");
      } finally {
        if (previousChild === undefined) delete process.env.PI_GEAR_CHILD;
        else process.env.PI_GEAR_CHILD = previousChild;
      }
    }
  });
}
