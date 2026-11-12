import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseModelSettings, FileModelSettingsStore } from "../model-settings.ts";

const valid = {
  version: 1,
  subagents: {
    researcher: { mode: "inherit" },
    worker: { mode: "override", provider: "provider", model: "org/model", thinkingLevel: "low" },
  },
} as const;

test("runtime config parser accepts strict inherit and override settings", () => {
  assert.deepEqual(parseModelSettings(valid), valid);

  const invalid = [
    {},
    { version: 2 },
    { version: 1, extra: true },
    { version: 1, subagents: { other: { mode: "inherit" } } },
    { version: 1, subagents: { worker: { mode: "inherit", model: "x" } } },
    { version: 1, subagents: { worker: { mode: "override", provider: "p", model: "m" } } },
  ];
  for (const value of invalid) assert.throws(() => parseModelSettings(value));
});

test("runtime config store persists updates and preserves invalid files", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-runtime-"));
  try {
    const path = join(root, "gear", "runtime.json");
    const store = new FileModelSettingsStore(path);
    await store.load();
    await store.set("worker", valid.subagents.worker);

    assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
      version: 1,
      subagents: { worker: valid.subagents.worker },
    });

    const invalidPath = join(root, "invalid.json");
    await writeFile(invalidPath, "not json");
    const invalid = new FileModelSettingsStore(invalidPath);
    await invalid.load();
    await assert.rejects(() => invalid.set("worker", { mode: "inherit" }), /Invalid runtime config/);
    assert.equal(await readFile(invalidPath, "utf8"), "not json");

    const blockedPath = join(root, "blocker", "runtime.json");
    const blocked = new FileModelSettingsStore(blockedPath);
    await blocked.load();
    await writeFile(join(root, "blocker"), "not a directory");
    await assert.rejects(() => blocked.set("worker", valid.subagents.worker));
    assert.equal(blocked.get("worker"), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
