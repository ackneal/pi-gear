import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupMcpCapabilities } from "./adapter.ts";
import { RESEARCH_MCP_CAPABILITIES, mcpToolName } from "./specs.ts";
import type { McpCapabilitySpec } from "./types.ts";

for (const { name, specs, expected } of [
  { name: "registers no servers for empty capabilities", specs: [], expected: [] },
  {
    name: "registers research servers with only allowlisted tools exposed directly",
    specs: RESEARCH_MCP_CAPABILITIES,
    expected: [
      ["exa", {
        url: "https://mcp.exa.ai/mcp?tools=web_search_exa,web_fetch_exa",
        exposure: "hidden",
        toolExposure: { web_search_exa: "direct", web_fetch_exa: "direct" },
      }],
      ["gh_grep", {
        url: "https://mcp.grep.app",
        exposure: "hidden",
        toolExposure: { searchGitHub: "direct" },
      }],
    ],
  },
] satisfies { name: string; specs: readonly McpCapabilitySpec[]; expected: unknown[] }[]) {
  test(name, () => {
    const registered: unknown[] = [];
    const pi = {
      registerMcpServer: (id: string, config: unknown) => { registered.push([id, config]); },
    } as unknown as ExtensionAPI;

    setupMcpCapabilities(pi, specs);

    assert.deepEqual(registered, expected);
  });
}

for (const { server, tool, expected } of [
  { server: "exa", tool: "web_search_exa", expected: "mcp__exa__web_search_exa" },
  { server: "gh_grep", tool: "searchGitHub", expected: "mcp__gh_grep__searchGitHub" },
  { server: "test-server", tool: "search.code", expected: "mcp__test_server__search_code" },
]) {
  test(`native MCP tool name: ${server}/${tool}`, () => {
    const name = mcpToolName(server, tool);

    assert.equal(name, expected);
  });
}
