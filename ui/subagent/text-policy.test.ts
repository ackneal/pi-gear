import assert from "node:assert/strict";
import test from "node:test";
import { readableProvider } from "./text-policy.ts";

const cases: ReadonlyArray<[name: string, expected: string]> = [
  ["exa_web_search_exa", "Exa"],
  ["exa_web_fetch_exa", "Exa"],
  ["mcp__exa__search", "Exa"],
  ["gh_grep_searchGitHub", "GitHub grep"],
  ["mcp__gh_grep__searchGitHub", "GitHub grep"],
  ["mcp__acme__lookup", "Acme"],
  ["read", "Read"],
];

test("readableProvider labels bridged and generic tool names", () => {
  for (const [name, expected] of cases) assert.equal(readableProvider(name), expected, name);
});
