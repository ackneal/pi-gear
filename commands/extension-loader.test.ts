import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Pi's extension loader loads gear with its package aliases", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
  const loaderUrl = new URL("./core/extensions/loader.js", import.meta.resolve("@earendil-works/pi-coding-agent"));
  const { loadExtensions } = await import(loaderUrl.href);
  const result = await loadExtensions([entry], root);

  assert.deepEqual(result.errors, []);
  assert.equal(result.extensions.length, 1);
});
