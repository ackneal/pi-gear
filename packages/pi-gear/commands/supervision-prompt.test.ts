import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ROSTRIX_RUNTIME_SYMBOL, type RostrixRuntime } from "pi-rostrix";

const sdk = import.meta.resolve("@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(new URL("./core/extensions/loader.js", sdk).href);
const { normalizeBuildSystemPromptOptions, buildSystemPrompt } = await import(new URL("./core/system-prompt.js", sdk).href);

test("Gear and Rostrix compose their own prompt contracts through Pi's extension loader", async () => {
  const shared = globalThis as typeof globalThis & { [ROSTRIX_RUNTIME_SYMBOL]?: RostrixRuntime };
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const previousChild = process.env.PI_GEAR_CHILD;
  delete process.env.PI_GEAR_CHILD;
  try {
    const loaded = await loadExtensions([entry], root);
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const runtime = shared[ROSTRIX_RUNTIME_SYMBOL];
    assert.ok(runtime);
    assert.equal(runtime.getActiveProfile(), undefined);

    for (const selectedTools of [["worker", "subagent_observe"], ["researcher"], ["reviewer"], ["read"]]) {
      const options = normalizeBuildSystemPromptOptions({ cwd: root, customPrompt: "Original role", selectedTools });
      for (const handler of loaded.extensions[0].handlers.get("before_agent_start") ?? []) {
        const result = await handler({
          type: "before_agent_start", prompt: "Work", systemPromptOptions: options,
          get systemPrompt() { return buildSystemPrompt(options); },
        });
        if (result?.systemPrompt !== undefined) options.forceSystemPrompt = result.systemPrompt;
      }
      const rendered: string = buildSystemPrompt(options);
      const delegates = selectedTools.some((name) => ["worker", "researcher", "reviewer"].includes(name));
      assert.ok(rendered.includes("Original role"));
      assert.equal(rendered.match(/<rostrix_supervision>/g)?.length ?? 0, delegates ? 1 : 0);
      assert.equal(rendered.match(/<pi_gear_context>/g)?.length ?? 0, delegates ? 1 : 0);
      if (delegates) {
        assert.match(rendered, /Only enabled, unconsumed events produce rostrix:subagent_notifications custom messages/);
        assert.match(rendered, /end the turn/);
        assert.doesNotMatch(rendered, /Observe healthy runs again as needed/);
      }
    }
  } finally {
    await shared[ROSTRIX_RUNTIME_SYMBOL]?.dispose();
    if (previousChild === undefined) delete process.env.PI_GEAR_CHILD;
    else process.env.PI_GEAR_CHILD = previousChild;
  }
});
