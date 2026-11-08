import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";
import { nativeGrep } from "./native.ts";

async function withFakeRg(
  script: string,
  run: (root: string, directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "pi-gear-native-grep-"));
  const bin = join(directory, "bin");
  const root = join(directory, "root");
  await Promise.all([mkdir(bin), mkdir(root)]);
  await writeFile(join(bin, "rg"), script);
  await chmod(join(bin, "rg"), 0o755);

  const previousPath = process.env.PATH;
  const previousRoot = process.env.SEARCH_ROOT;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;
  process.env.SEARCH_ROOT = root;
  try {
    await run(root, directory);
  } finally {
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

test("native grep filters content before applying the visible limit", async () => {
  const rg = `#!/bin/sh
printf '%s\n' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/denied-a.ts"},"lines":{"text":"secret-a\\n"},"line_number":1}}' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/denied-b.ts"},"lines":{"text":"secret-b\\n"},"line_number":1}}' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/allowed-a.ts"},"lines":{"text":"visible-a\\n"},"line_number":1}}' \\
'{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/allowed-b.ts"},"lines":{"text":"visible-b\\n"},"line_number":1}}'
`;
  await withFakeRg(rg, async (root) => {
    const matches = await nativeGrep(root, access, "needle", { regex: false, ignoreCase: false, context: 0, limit: 2 });

    assert.deepEqual(matches.map(({ relativePath, lineContent }) => [relativePath, lineContent]), [
      ["allowed-a.ts", "visible-a"],
      ["allowed-b.ts", "visible-b"],
    ]);
    assert.equal(JSON.stringify(matches).includes("denied"), false);
    assert.equal(JSON.stringify(matches).includes("secret"), false);
  });
});

test("native grep searches hidden files", async () => {
  const rg = `#!/bin/sh
printf '%s\n' "$@" > "$SEARCH_ROOT/argv"
printf '%s\n' '{"type":"match","data":{"path":{"text":"'"$SEARCH_ROOT"'/.github/workflow.yml"},"lines":{"text":"hidden match\\n"},"line_number":1}}'
`;
  await withFakeRg(rg, async (root) => {
    const matches = await nativeGrep(root, { permits: async () => true }, "hidden", {
      regex: false,
      ignoreCase: false,
      context: 0,
      limit: 10,
    });
    const argv = (await readFile(join(root, "argv"), "utf8")).split("\n");

    assert.equal(argv.includes("--hidden"), true);
    assert.equal(matches[0]?.relativePath, ".github/workflow.yml");
  });
});

test("native rg is terminated when its signal is aborted", async () => {
  const rg = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "rg 10.0.0"; exit 0; fi
echo ready > "$SEARCH_STATE/rg-ready"
trap 'echo terminated > "$SEARCH_STATE/rg-terminated"; exit 0' TERM
while :; do sleep 1; done
`;
  await withFakeRg(rg, async (root, directory) => {
    process.env.SEARCH_STATE = directory;
    try {
      const controller = new AbortController();
      const reason = new Error("stop rg");
      const grepping = nativeGrep(
        root,
        access,
        "needle",
        { regex: false, ignoreCase: false, context: 0, limit: 2 },
        controller.signal,
      );
      await waitForFile(join(directory, "rg-ready"));
      controller.abort(reason);
      await rejectsPromptly(grepping, reason);
      await waitForFile(join(directory, "rg-terminated"));
    } finally {
      delete process.env.SEARCH_STATE;
    }
  });
});
