import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";
import { nativeFind, nativeGrep } from "./native.ts";

async function withFakeSearchCommands(run: (root: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-gear-native-search-"));
  const bin = join(directory, "bin");
  const root = join(directory, "root");
  await Promise.all([mkdir(bin), mkdir(root)]);

  const fd = `#!/bin/sh\nprintf '%s\\0%s\\0%s\\0%s\\0' "$SEARCH_ROOT/denied-a.ts" "$SEARCH_ROOT/denied-b.ts" "$SEARCH_ROOT/allowed-a.ts" "$SEARCH_ROOT/allowed-b.ts"\n`;
  const rg = `#!/bin/sh\nprintf '%s\\n' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/denied-a.ts"},"lines":{"text":"secret-a\\n"},"line_number":1}}' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/denied-b.ts"},"lines":{"text":"secret-b\\n"},"line_number":1}}' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/allowed-a.ts"},"lines":{"text":"visible-a\\n"},"line_number":1}}' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/allowed-b.ts"},"lines":{"text":"visible-b\\n"},"line_number":1}}'\n`;
  await Promise.all([writeFile(join(bin, "fd"), fd), writeFile(join(bin, "rg"), rg)]);
  await Promise.all([chmod(join(bin, "fd"), 0o755), chmod(join(bin, "rg"), 0o755)]);

  const previousPath = process.env.PATH;
  const previousRoot = process.env.SEARCH_ROOT;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SEARCH_ROOT = root;
  try { await run(root); }
  finally {
    process.env.PATH = previousPath;
    if (previousRoot === undefined) delete process.env.SEARCH_ROOT;
    else process.env.SEARCH_ROOT = previousRoot;
    await rm(directory, { recursive: true, force: true });
  }
}

const access = {
  permits: async (path: string) => !path.includes("denied"),
} as FilesystemAccess;

test("native fd and rg continue past denied candidates until the visible limit", async () => {
  await withFakeSearchCommands(async (root) => {
    const found = await nativeFind(root, "*.ts", access, 2);
    const matches = await nativeGrep(root, access, "needle", { regex: false, ignoreCase: false, context: 0, limit: 2 });

    assert.deepEqual(found, ["allowed-a.ts", "allowed-b.ts"]);
    assert.deepEqual(matches.map(({ relativePath, lineContent }) => [relativePath, lineContent]), [
      ["allowed-a.ts", "visible-a"],
      ["allowed-b.ts", "visible-b"],
    ]);
    assert.equal(JSON.stringify(matches).includes("denied"), false);
    assert.equal(JSON.stringify(matches).includes("secret"), false);
  });
});
