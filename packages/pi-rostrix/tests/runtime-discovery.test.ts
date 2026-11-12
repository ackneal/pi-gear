import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { initRuntime, type DiscoverAgentsOptions, type RuntimeOptions } from "../src/index.ts";

const disabled: RuntimeOptions = {
  autoRegisterTaskTools: false,
  autoRegisterAgentControls: false,
  autoLoadDefinitions: false,
};

function createPi(): ExtensionAPI {
  return { on: () => () => {} } as unknown as ExtensionAPI;
}

test("initialization starts discovery only when automatic loading is enabled", async (t) => {
  for (const row of [
    { name: "default discovery options", options: {}, enabled: true },
    { name: "definitions enabled", options: { autoLoadDefinitions: true }, enabled: true },
    { name: "definitions disabled", options: { autoLoadDefinitions: false }, enabled: false },
  ]) {
    await t.test(row.name, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "rostrix-discovery-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const pi = createPi();
      const runtime = initRuntime(pi, disabled);
      t.after(() => runtime.dispose());
      const originalLoad = runtime.loadAgentDefinitions.bind(runtime);
      let pending: ReturnType<typeof originalLoad> | undefined;
      const load = t.mock.method(runtime, "loadAgentDefinitions", () => {
        pending = originalLoad({ userDir: directory, projectDir: directory });
        return pending;
      });
      const options = { autoRegisterTaskTools: false, autoRegisterAgentControls: false, ...row.options };

      assert.strictEqual(initRuntime(pi, options), runtime);
      initRuntime(pi, options);
      assert.equal(load.mock.callCount(), row.enabled ? 1 : 0);
      if (pending) await pending;
      initRuntime(pi, options);
      assert.equal(load.mock.callCount(), row.enabled ? 1 : 0);

      if (!row.enabled) {
        initRuntime(pi, { ...options, autoLoadDefinitions: true });
        assert.equal(load.mock.callCount(), 1);
        await pending;
      }
    });
  }
});

test("explicit discovery satisfies later automatic initialization", async (t) => {
  for (const row of [
    { name: "empty completed scan", populated: false, complete: true },
    { name: "populated completed scan", populated: true, complete: true },
    { name: "scan still in progress", populated: true, complete: false },
  ]) {
    await t.test(row.name, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "rostrix-discovery-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      if (row.populated) {
        await writeFile(join(directory, "agent.json"), JSON.stringify({
          id: "discovered", label: "Discovered", description: "Discovered agent",
        }));
      }
      const pi = createPi();
      const runtime = initRuntime(pi, disabled);
      t.after(() => runtime.dispose());
      const load = t.mock.method(runtime, "loadAgentDefinitions");
      const pending = runtime.loadAgentDefinitions({ userDir: directory, projectDir: directory });
      if (row.complete) await pending;

      initRuntime(pi, { autoRegisterTaskTools: false, autoRegisterAgentControls: false });
      await pending;
      initRuntime(pi, { autoRegisterTaskTools: false, autoRegisterAgentControls: false });

      assert.equal(load.mock.callCount(), 1);
      assert.equal(runtime.discoveredAgents.length, row.populated ? 1 : 0);
      assert.equal(runtime.getAllAgents().length, row.populated ? 1 : 0);
    });
  }
});

test("discovery preserves registered definitions and permits intentional later scans", async (t) => {
  for (const loadAlias of ["loadAgentDefinitions"] as const) {
    await t.test(loadAlias, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "rostrix-discovery-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const runtime = initRuntime(createPi(), disabled);
      t.after(() => runtime.dispose());
      runtime.registerAgent({ id: "existing", label: "Keep me", description: "Registered before discovery" });
      const existing = runtime.getAgent("existing");
      await writeFile(join(directory, "existing.json"), JSON.stringify({
        id: "existing", label: "Do not replace", description: "Conflicting discovered definition",
      }));
      await writeFile(join(directory, "fresh.json"), JSON.stringify({
        id: "fresh", label: "Fresh", description: "New discovered definition",
      }));
      const options: DiscoverAgentsOptions = { userDir: directory, projectDir: directory };

      const first = await runtime[loadAlias](options);
      const fresh = runtime.getAgent("fresh");
      await writeFile(join(directory, "later.json"), JSON.stringify({
        id: "later", label: "Later", description: "Found by an explicit later scan",
      }));
      const second = await runtime[loadAlias](options);

      assert.equal(first.agents.length, 2);
      assert.equal(second.agents.length, 3);
      assert.strictEqual(runtime.getAgent("existing"), existing);
      assert.strictEqual(runtime.getAgent("fresh"), fresh);
      assert.equal(runtime.getAgent("existing")?.label, "Keep me");
      assert.ok(runtime.getAgent("later"));
      assert.equal(runtime.discoveredAgents.length, 3);
    });
  }
});

test("a failed initial discovery is not retried by initialization", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "rostrix-discovery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, "invalid.json"), "invalid JSON");
  const pi = createPi();
  const runtime = initRuntime(pi, disabled);
  t.after(() => runtime.dispose());
  const load = t.mock.method(runtime, "loadAgentDefinitions");
  const failure = new Error("Warning callback failed");
  const pending = runtime.loadAgentDefinitions({
    userDir: directory, projectDir: directory,
    onWarning: () => { throw failure; },
  });

  await assert.rejects(pending, (error) => error === failure);
  initRuntime(pi, { autoRegisterTaskTools: false, autoRegisterAgentControls: false });

  assert.equal(load.mock.callCount(), 1);
  assert.equal(runtime.discoveredAgents.length, 0);
  assert.equal(runtime.getAllAgents().length, 0);
  const recovered = await runtime.loadAgentDefinitions({ userDir: directory, projectDir: directory });
  assert.ok(recovered.errors.length > 0);
  assert.equal(load.mock.callCount(), 2);
});

test("discovery cannot repopulate a disposing or disposed runtime", async (t) => {
  for (const row of [
    { name: "pending discovery completes after disposal starts", startBeforeDisposal: true },
    { name: "discovery requested during disposal", startBeforeDisposal: false },
  ]) {
    await t.test(row.name, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), "rostrix-discovery-"));
      t.after(() => rm(directory, { recursive: true, force: true }));
      await writeFile(join(directory, "agent.json"), JSON.stringify({
        id: "discovered", label: "Discovered", description: "Must not survive disposal",
      }));
      const runtime = initRuntime(createPi(), disabled);
      t.after(() => runtime.dispose());
      const options = { userDir: directory, projectDir: directory };
      const pending = row.startBeforeDisposal ? runtime.loadAgentDefinitions(options) : undefined;

      const disposal = runtime.dispose();
      if (pending) {
        assert.equal((await pending).agents.length, 1);
      } else {
        await assert.rejects(runtime.loadAgentDefinitions(options), /disposing or disposed/);
      }
      await disposal;

      assert.equal(runtime.isInitialized, false);
      assert.equal(runtime.getAllAgents().length, 0);
      assert.equal(runtime.discoveredAgents.length, 0);
      await assert.rejects(runtime.loadAgentDefinitions(options), /disposing or disposed/);
    });
  }
});
