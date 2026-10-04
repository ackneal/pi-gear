import assert from "node:assert/strict";
import test from "node:test";
import { readableProvider } from "./text-policy.ts";

const cases: ReadonlyArray<[name: string, expected: string]> = [
  ["mcp__exa__web_search_exa", "Exa"],
  ["mcp__exa__web_fetch_exa", "Exa"],
  ["mcp__gh_grep__searchGitHub", "GitHub grep"],
  ["mcp__acme__lookup", "Acme"],
  ["read", "Read"],
];

test("readableProvider labels native MCP and generic tool names", () => {
  for (const [name, expected] of cases) assert.equal(readableProvider(name), expected, name);
});
