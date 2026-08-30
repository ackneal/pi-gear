import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";
import { nativeFind, nativeGrep } from "./native.ts";

async function withFakeSearchCommands(
  run: (root: string, directory: string) => Promise<void>,
  scripts?: { fd?: string; rg?: string },
): Promise<void> {
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
  await Promise.all([writeFile(join(bin, "fd"), scripts?.fd ?? fd), writeFile(join(bin, "rg"), scripts?.rg ?? rg)]);
  await Promise.all([chmod(join(bin, "fd"), 0o755), chmod(join(bin, "rg"), 0o755)]);

  const previousPath = process.env.PATH;
  const previousRoot = process.env.SEARCH_ROOT;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SEARCH_ROOT = root;
  try { await run(root, directory); }
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

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function rejectsPromptly(promise: Promise<unknown>, reason: Error): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("aborted search did not terminate")), 3_000);
  });
  try {
    await assert.rejects(Promise.race([promise, timeout]), (error) => error === reason);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

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

test("native find preserves recursive basename and full-path glob semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-native-find-globs-"));
  const files = [
    "top.spec.ts",
    "src/direct.spec.ts",
    "src/deep/nested.spec.ts",
    "other/src/deep/other.spec.ts",
    "one/parent/child/file.txt",
    ".hidden.spec.ts",
  ];
  try {
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), "test");
    }
    const allowAll = { permits: async () => true };

    const cases = [
      { pattern: "*.spec.ts", expected: [".hidden.spec.ts", "other/src/deep/other.spec.ts", "src/deep/nested.spec.ts", "src/direct.spec.ts", "top.spec.ts"] },
      { pattern: "src/**/*.spec.ts", expected: ["other/src/deep/other.spec.ts", "src/deep/nested.spec.ts", "src/direct.spec.ts"] },
      { pattern: "**/parent/child/*", expected: ["one/parent/child/file.txt"] },
    ];
    for (const { pattern, expected } of cases) {
      const found = await nativeFind(root, pattern, allowAll, 100);
      assert.deepEqual(found.sort(), expected);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native fd and rg are terminated when their signal is aborted", async () => {
  const hangingCommand = (name: string) => `#!/bin/sh\necho ready > "$SEARCH_STATE/${name}-ready"\ntrap 'echo terminated > "$SEARCH_STATE/${name}-terminated"; exit 0' TERM\nwhile :; do sleep 1; done\n`;

  await withFakeSearchCommands(async (root, directory) => {
    process.env.SEARCH_STATE = directory;
    try {
      const findController = new AbortController();
      const findReason = new Error("stop fd");
      const finding = nativeFind(root, "*.ts", access, 2, findController.signal);
      await waitForFile(join(directory, "fd-ready"));
      findController.abort(findReason);
      await rejectsPromptly(finding, findReason);
      await waitForFile(join(directory, "fd-terminated"));

      const grepController = new AbortController();
      const grepReason = new Error("stop rg");
      const grepping = nativeGrep(
        root,
        access,
        "needle",
        { regex: false, ignoreCase: false, context: 0, limit: 2 },
        grepController.signal,
      );
      await waitForFile(join(directory, "rg-ready"));
      grepController.abort(grepReason);
      await rejectsPromptly(grepping, grepReason);
      await waitForFile(join(directory, "rg-terminated"));
    } finally {
      delete process.env.SEARCH_STATE;
    }
  }, { fd: hangingCommand("fd"), rg: hangingCommand("rg") });
});
