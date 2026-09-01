import assert from "node:assert/strict";
import test from "node:test";
import type { AutocompleteProvider } from "@earendil-works/pi-tui";
import type { WorkspaceSearch } from "./service.ts";
import { WorkspaceAutocompleteProvider } from "./autocomplete.ts";

const fallback: AutocompleteProvider = {
  async getSuggestions() {
    return {
      prefix: "fallback",
      items: [{ value: "fallback", label: "fallback" }],
    };
  },
  applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
    const next = [...lines];
    next[cursorLine] = `${(next[cursorLine] ?? "").slice(0, cursorCol - prefix.length)}${item.value}`;
    return {
      lines: next,
      cursorLine,
      cursorCol: cursorCol - prefix.length + item.value.length,
    };
  },
};

test("FFF autocomplete preserves discovery ranking and tracks actual selection", async () => {
  const tracked: [string, string][] = [];
  const search = {
    mixedSearch: async () => ({
      items: [
        { type: "file", item: { relativePath: "src/allowed.ts" } },
        { type: "file", item: { relativePath: ".env" } },
        { type: "directory", item: { relativePath: "src" } },
      ],
      scores: [],
      totalMatched: 3,
      totalFiles: 2,
      totalDirs: 1,
    }),
    trackQuery: async (query: string, path: string) => {
      tracked.push([query, path]);
    },
  } as unknown as WorkspaceSearch;
  const provider = new WorkspaceAutocompleteProvider(fallback, search);

  const suggestions = await provider.getSuggestions(
    ["open @allow"],
    0,
    11,
    { signal: new AbortController().signal },
  );

  assert.deepEqual(suggestions?.items.map(({ label, description }) => [label, description]), [
    ["allowed.ts", "src/allowed.ts"],
    [".env", ".env"],
    ["src/", "src/"],
  ]);
  provider.applyCompletion(["open @allow"], 0, 11, suggestions!.items[0]!, "@allow");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(tracked, [["allow", "src/allowed.ts"]]);
});

test("FFF autocomplete clears selections from the previous suggestion batch", async () => {
  const tracked: [string, string][] = [];
  let path = "first.ts";
  const search = {
    mixedSearch: async () => ({
      items: [{ type: "file", item: { relativePath: path } }],
    }),
    trackQuery: async (query: string, selectedPath: string) => {
      tracked.push([query, selectedPath]);
    },
  } as unknown as WorkspaceSearch;
  const provider = new WorkspaceAutocompleteProvider(fallback, search);
  const signal = new AbortController().signal;

  const first = await provider.getSuggestions(["@first"], 0, 6, { signal });
  path = "second.ts";
  await provider.getSuggestions(["@second"], 0, 7, { signal });
  provider.applyCompletion(["@first"], 0, 6, first!.items[0]!, "@first");
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(tracked, []);
});

test("FFF autocomplete discards a search aborted while it is in flight", async () => {
  let resolveSearch!: (value: unknown) => void;
  let fallbackCalls = 0;
  const current = {
    ...fallback,
    async getSuggestions() {
      fallbackCalls += 1;
      return fallback.getSuggestions([], 0, 0, { signal: new AbortController().signal });
    },
  } as AutocompleteProvider;
  const search = {
    mixedSearch: async () => await new Promise((resolve) => {
      resolveSearch = resolve;
    }),
  } as unknown as WorkspaceSearch;
  const provider = new WorkspaceAutocompleteProvider(current, search);
  const controller = new AbortController();

  const pending = provider.getSuggestions(["open @src"], 0, 9, {
    signal: controller.signal,
  });
  controller.abort();
  resolveSearch({
    items: [{ type: "file", item: { relativePath: "src/index.ts" } }],
  });

  assert.equal(await pending, null);
  assert.equal(fallbackCalls, 0);
});
