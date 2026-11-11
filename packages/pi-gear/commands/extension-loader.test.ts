import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import { setupGear } from "../index.ts";
import { childArgs } from "../subagents/runtime/process.ts";
import { researcherProfile } from "../subagents/agents/researcher/profile.ts";
import { reviewerProfile } from "../subagents/agents/reviewer/profile.ts";
import { workerProfile } from "../subagents/agents/worker/profile.ts";

for (const { profile, extension, expectedServers } of [
  { profile: researcherProfile, extension: new URL("../subagents/agents/researcher/extension.ts", import.meta.url), expectedServers: ["exa", "gh_grep"] },
  { profile: workerProfile, extension: new URL("../index.ts", import.meta.url), expectedServers: [] },
  { profile: reviewerProfile, extension: new URL("../index.ts", import.meta.url), expectedServers: [] },
]) {
  test(`${profile.id} child loads one shared runtime without recursive subagents`, async () => {
    const previous = process.env.PI_GEAR_CHILD;
    process.env.PI_GEAR_CHILD = "1";
    try {
      const root = fileURLToPath(new URL("../", import.meta.url));
      const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
      const args = childArgs(profile, "test", extension);
      const paths = args.flatMap((arg, index) => arg === "--extension" ? [args[index + 1]] : []);
      const loaderUrl = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
      const { loadExtensions } = await import(loaderUrl.href);

      const result = await loadExtensions(paths, root);

      assert.deepEqual(result.errors, []);
      assert.equal(result.extensions.filter((loaded: { path: string }) => loaded.path === entry).length, 1);
      const runtime = result.extensions.find((loaded: { path: string }) => loaded.path === entry);
      assert.ok(runtime.handlers.has("tool_call"));
      assert.ok(runtime.handlers.has("user_bash"));
      assert.ok(runtime.handlers.has("session_start"));
      assert.equal(runtime.commands.size, 0);
      assert.equal(runtime.tools.has("researcher"), false);
      assert.equal(runtime.tools.has("worker"), false);
      assert.equal(runtime.tools.has("reviewer"), false);
      assert.equal(runtime.tools.has("request_command"), false);
      for (const loaded of result.extensions) {
        if (loaded.path !== entry) assert.equal(loaded.handlers.size, 0);
      }
      assert.deepEqual(result.runtime.mcpServers.list().map(({ name }: { name: string }) => name), expectedServers);
    } finally {
      if (previous === undefined) delete process.env.PI_GEAR_CHILD;
      else process.env.PI_GEAR_CHILD = previous;
    }
  });
}

test("in-process child explicitly loads safety policies without host UI or recursive agents", async () => {
  const previous = process.env.PI_GEAR_CHILD;
  const loader = new DefaultResourceLoader({
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    agentDir: fileURLToPath(new URL("../../../.pi", import.meta.url)),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [(pi) => setupGear(pi, { child: true })],
  });
  await loader.reload();
  const result = loader.getExtensions();
  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
  const child = result.extensions[0]!;
  assert.ok(child.handlers.has("tool_call"));
  assert.ok(child.handlers.has("user_bash"));
  assert.equal(child.commands.size, 0);
  for (const tool of ["researcher", "worker", "reviewer", "request_command"]) {
    assert.equal(child.tools.has(tool), false, tool);
  }
  assert.equal(process.env.PI_GEAR_CHILD, previous);
});

test("Pi's extension loader loads gear with its package aliases", async () => {
  const previous = process.env.PI_GEAR_CHILD;
  delete process.env.PI_GEAR_CHILD;
  try {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
    const loaderUrl = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
    const { loadExtensions } = await import(loaderUrl.href);
    const result = await loadExtensions([entry], root);

    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.equal(result.extensions[0].tools.has("request_command"), true);
  } finally {
    if (previous === undefined) delete process.env.PI_GEAR_CHILD;
    else process.env.PI_GEAR_CHILD = previous;
  }
});

test("Pi's extension loader registers researcher native MCP servers", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entry = fileURLToPath(new URL("../subagents/agents/researcher/extension.ts", import.meta.url));
  const loaderUrl = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { loadExtensions } = await import(loaderUrl.href);

  const result = await loadExtensions([entry], root);

  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions[0].handlers.size, 0);
  assert.equal(result.extensions[0].tools.size, 0);
  assert.deepEqual(result.runtime.mcpServers.list().map(({ name, config }: { name: string; config: unknown }) => ({ name, config })), [
    {
      name: "exa",
      config: {
        url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
        exposure: "hidden",
        toolExposure: { web_search_exa: "direct", web_fetch_exa: "direct" },
      },
    },
    {
      name: "gh_grep",
      config: {
        url: "https://mcp.grep.app",
        exposure: "hidden",
        toolExposure: { searchGitHub: "direct" },
      },
    },
  ]);
});
