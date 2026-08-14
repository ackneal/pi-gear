import type { McpCapabilitySpec } from "./types.ts";

export const RESEARCH_MCP_CAPABILITIES = [
  {
    kind: "mcp",
    id: "exa",
    endpoint: "https://mcp.exa.ai/mcp",
    tools: [
      { name: "web_search_exa" },
      { name: "get_code_context_exa" },
      { name: "research_paper_exa" },
      { name: "crawling_exa" },
    ],
  },
  {
    kind: "mcp",
    id: "context7",
    endpoint: "https://mcp.context7.com/mcp",
    tools: [{ name: "resolve-library-id" }, { name: "query-docs" }],
  },
  {
    kind: "mcp",
    id: "gh_grep",
    endpoint: "https://mcp.grep.app",
    tools: [{ name: "searchGitHub" }],
  },
] as const satisfies readonly McpCapabilitySpec[];

export function bridgeToolName(capabilityId: string, toolName: string): string {
  return `${capabilityId}_${toolName.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}
