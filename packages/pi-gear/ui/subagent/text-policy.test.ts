import assert from "node:assert/strict";
import test from "node:test";
import { readableActivityName, readableProvider } from "./text-policy.ts";

const cases: ReadonlyArray<[name: string, expected: string]> = [
  ["mcp__exa__web_search_exa", "Exa"],
  ["mcp__exa__web_fetch_exa", "Exa"],
  ["mcp__gh_grep__searchGitHub", "GitHub grep"],
  ["mcp__acme__lookup", "Acme"],
  ["read", "Read"],
];

const activityCases: ReadonlyArray<[name: string, expected: string]> = [
  ["mcp__exa__web_search_exa", "Exa search"],
  ["mcp__exa__web_fetch_exa", "Exa fetch"],
  ["mcp__exa__crawling_exa", "Exa fetch"],
  ["mcp__exa__get_code_context_exa", "Exa code"],
  ["mcp__exa__company_research_exa", "Exa"],
  ["mcp__gh_grep__searchGitHub", "GitHub grep"],
  ["read", "Read"],
];

test("readableProvider labels native MCP and generic tool names", () => {
  for (const [name, expected] of cases) assert.equal(readableProvider(name), expected, name);
});

test("readableActivityName distinguishes Exa actions while preserving other labels", () => {
  for (const [name, expected] of activityCases) assert.equal(readableActivityName(name), expected, name);
});
