import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
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
      assert.equal(runtime.handlers.has("user_bash"), false);
      assert.ok(runtime.handlers.has("session_start"));
      assert.equal(runtime.commands.size, 0);
      assert.equal(runtime.tools.has("subagent_spawn_research"), false);
      assert.equal(runtime.tools.has("subagent_spawn_work"), false);
      assert.equal(runtime.tools.has("subagent_spawn_review"), false);
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
    for (const name of ["subagent_spawn_research", "subagent_spawn_work", "subagent_spawn_review"]) {
      assert.equal(result.extensions[0].tools.has(name), true);
    }
    for (const name of ["researcher", "worker", "reviewer"]) {
      assert.equal(result.extensions[0].tools.has(name), false);
    }
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
