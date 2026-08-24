import assert from "node:assert/strict";
import test from "node:test";
import { lspErrorPatch } from "./index.ts";
import type { LspManager } from "./manager.ts";

const event = (toolName: string, isError = false) => ({
  toolName,
  isError,
  input: { path: "source.ts" },
  content: [{ type: "text" as const, text: "Updated source.ts" }],
});

test("successful edit/write surface only new LSP errors", async () => {
  let calls = 0;
  const manager = {
    match: (path: string) => path.endsWith(".ts") ? {} : undefined,
    newErrors: async () => {
      calls++;
      return calls === 1
        ? [{ path: "source.ts", line: 2, column: 3, severity: "error", message: "broken" }]
        : [];
    },
  } as unknown as LspManager;

  const first = await lspErrorPatch(manager, event("edit"));
  assert.match(first?.content.at(-1)?.text ?? "", /New LSP errors:\nsource\.ts:2:3 error: broken/);
  assert.equal(await lspErrorPatch(manager, event("write")), undefined);
  assert.equal(await lspErrorPatch(manager, event("read")), undefined);
  assert.equal(await lspErrorPatch(manager, event("edit", true)), undefined);
  assert.equal(calls, 2);
});
