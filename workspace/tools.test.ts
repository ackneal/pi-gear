import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FileFinder } from "@ff-labs/fff-node";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";
import type { FffClient } from "../lifecycle/fff-client.ts";
import { WorkspaceSearch } from "./service.ts";
import { registerWorkspaceTools } from "./tools.ts";

const item = (relativePath: string) => ({
  relativePath,
  fileName: relativePath,
  size: 1,
  modified: 1,
  accessFrecencyScore: 0,
  modificationFrecencyScore: 0,
  totalFrecencyScore: 0,
  gitStatus: "clean",
});

const match = (relativePath: string, lineContent: string) => ({
  ...item(relativePath),
  isBinary: false,
  lineNumber: 1,
  col: 0,
  byteOffset: 0,
  lineContent,
  matchRanges: [],
});

async function setup(accessOverride?: Partial<FilesystemAccess>) {
  let grepPage = 0;
  const grepRequests: unknown[] = [];
  const client = {
    request: async (method: string, params: unknown) => {
      if (method === "glob") {
        return {
          items: [item(".env"), item("src/allowed.ts")],
          scores: [],
          totalMatched: 2,
          totalFiles: 2,
        };
      }
      if (method === "grep") {
        grepRequests.push(params);
        grepPage++;
        return grepPage === 1
          ? {
              items: [match(".env", "secret")],
              nextCursor: { __brand: "GrepCursor", _offset: 1 },
            }
          : { items: [match("src/allowed.ts", "visible")], nextCursor: null };
      }
      throw new Error(method);
    },
  } as unknown as FffClient;
  const access = {
    filter: async (paths: readonly string[]) => paths.filter((path) => !path.endsWith(".env")),
    ...accessOverride,
  } as unknown as FilesystemAccess;
  const search = new WorkspaceSearch(process.cwd(), access, client);
  const tools = new Map<string, ToolDefinition>();
  let activeTools: string[] = [];
  const pi = {
    registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
    getActiveTools: () => ["read"],
    setActiveTools: (names: string[]) => { activeTools = names; },
  } as unknown as ExtensionAPI;

  registerWorkspaceTools(pi, search, access);
  return { tools, activeTools, grepRequests, grepPages: () => grepPage };
}

const run = (tool: ToolDefinition, input: Record<string, unknown>) => tool.execute(
  "id",
  input,
  undefined,
  undefined,
  { cwd: process.cwd(), hasUI: false } as never,
);

const text = async (result: ReturnType<typeof run>) =>
  (await result).content
    .map((part) => part.type === "text" ? part.text : "")
    .join("\n");

test("workspace find filters denied paths before applying the visible limit", async () => {
  const { tools } = await setup();
  const output = await text(run(tools.get("find")!, { pattern: "*", limit: 1 }));

  assert.match(output, /src\/allowed\.ts/);
  assert.doesNotMatch(output, /\.env/);
});

test("workspace grep filters denied pages and continues to allowed content", async () => {
  const { tools, grepPages } = await setup();
  const output = await text(run(tools.get("grep")!, { pattern: "needle", literal: true, limit: 1 }));

  assert.equal(grepPages(), 2);
  assert.match(output, /visible/);
  assert.doesNotMatch(output, /secret|\.env/);
});

test("workspace grep maps case-insensitive literal search without exposing FFF options", async () => {
  const { tools, grepRequests } = await setup();

  await run(tools.get("grep")!, {
    pattern: "Exact.Value",
    literal: true,
    ignoreCase: true,
    limit: 1,
  });

  assert.deepEqual(grepRequests[0], {
    query: "(?i:Exact\\.Value)",
    options: {
      mode: "regex",
      smartCase: false,
      cursor: null,
      beforeContext: 0,
      afterContext: 0,
      maxMatchesPerFile: 2,
      pageSize: 100,
    },
  });
});

test("external search roots are rejected by policy before either backend runs", async () => {
  const requests: string[] = [];
  const { tools } = await setup({
    authorize: async () => ({ path: "/outside", canonicalPath: "/outside", withinWorkspace: false, decision: "deny" }),
    request: async (_path, _operation, label) => {
      requests.push(label);
      return { path: "/outside", canonicalPath: "/outside", withinWorkspace: false, decision: "deny" };
    },
  });

  for (const name of ["find", "grep"] as const) {
    await assert.rejects(run(tools.get(name)!, { pattern: "needle", path: "/outside" }), /Access is not permitted/);
  }
  assert.deepEqual(requests, []);
});

test("approved external roots expose ordinary children but retain nested denies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-gear-approved-search-"));
  const workspace = join(directory, "workspace");
  const external = join(directory, "external");
  try {
    await Promise.all([mkdir(workspace), mkdir(join(external, "denied"), { recursive: true })]);
    await Promise.all([
      writeFile(join(external, "visible.ts"), "foo\n"),
      writeFile(join(external, "escape.ts"), "foo\n"),
      writeFile(join(external, "denied", "secret.ts"), "foo\n"),
    ]);

    const authorization = (path: string, decision: "allow" | "ask" | "deny") => ({
      path,
      canonicalPath: path,
      withinWorkspace: false,
      decision,
    });
    const access = {
      filter: async (paths: readonly string[]) => [...paths],
      authorize: async (path: string) => {
        if (path.includes(`${join(external, "denied")}/`)) return authorization(path, "deny");
        if (path.endsWith("escape.ts")) return { ...authorization(path, "ask"), canonicalPath: join(directory, "escaped", "escape.ts") };
        return authorization(path, "ask");
      },
      request: async (path: string) => authorization(path, "allow"),
    } as unknown as FilesystemAccess;
    const client = { request: async () => { throw new Error("workspace backend should not run"); } } as unknown as FffClient;
    const search = new WorkspaceSearch(workspace, access, client);
    const tools = new Map<string, ToolDefinition>();
    const pi = {
      registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
      getActiveTools: () => [],
      setActiveTools: () => undefined,
    } as unknown as ExtensionAPI;
    registerWorkspaceTools(pi, search, access);

    const output = await text(tools.get("find")!.execute(
      "id",
      { pattern: "*.ts", path: external },
      undefined,
      undefined,
      { cwd: workspace, hasUI: true } as never,
    ));

    assert.match(output, /visible\.ts/);
    assert.doesNotMatch(output, /secret\.ts|denied|escape\.ts/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("real FFF workspace find preserves recursive Pi glob semantics", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-fff-find-"));
  const files = [
    "top.spec.ts",
    "src/direct.spec.ts",
    "src/deep/nested.spec.ts",
    "other/src/deep/other.spec.ts",
    "one/parent/child/file.txt",
  ];
  try {
    for (const file of files) {
      await mkdir(join(root, file, ".."), { recursive: true });
      await writeFile(join(root, file), file === "top.spec.ts" ? "largefoo\n".repeat(500) : "foo\n");
    }

    const created = FileFinder.create({ basePath: root, disableWatch: true, disableContentIndexing: false });
    if (!created.ok) throw new Error(created.error);
    const finder = created.value;
    try {
      const scanned = await finder.waitForScan(5_000);
      if (!scanned.ok || !scanned.value) throw new Error(scanned.ok ? "FFF scan timed out" : scanned.error);
      let grepItems = 0;
      const client = {
        request: async (method: string, params: any) => {
          const result = method === "glob"
            ? finder.glob(params.pattern, params.options)
            : finder.grep(params.query, params.options);
          if (!result.ok) throw new Error(result.error);
          if (method === "grep") grepItems += result.value.items.length;
          return result.value;
        },
      } as unknown as FffClient;
      const allowAll = { filter: async (paths: readonly string[]) => [...paths] } as unknown as FilesystemAccess;
      const search = new WorkspaceSearch(root, allowAll, client);
      const tools = new Map<string, ToolDefinition>();
      const pi = {
        registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool),
        getActiveTools: () => [],
        setActiveTools: () => undefined,
      } as unknown as ExtensionAPI;
      registerWorkspaceTools(pi, search, allowAll);

      const cases = [
        { pattern: "*.spec.ts", expected: ["top.spec.ts", "src/direct.spec.ts", "src/deep/nested.spec.ts", "other/src/deep/other.spec.ts"] },
        { pattern: "src/**/*.spec.ts", expected: ["src/direct.spec.ts", "src/deep/nested.spec.ts"] },
        { pattern: "**/parent/child/*", expected: ["one/parent/child/file.txt"] },
      ];
      for (const { pattern, expected } of cases) {
        const output = await text(run(tools.get("find")!, { pattern, limit: 100 }));
        for (const path of expected) assert.match(output, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        for (const path of files.filter((path) => !expected.includes(path))) {
          assert.doesNotMatch(output, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
        }
      }

      const grepOutput = await text(run(tools.get("grep")!, { pattern: "largefoo", literal: true, limit: 500 }));
      assert.equal(grepItems, 500);
      assert.match(grepOutput, /1: largefoo/);
    } finally {
      finder.destroy();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("find and grep keep their public contracts without pagination or ls exposure", async () => {
  const { tools, activeTools } = await setup();
  const findKeys = Object.keys((tools.get("find")!.parameters as any).properties).sort();
  const grepKeys = Object.keys((tools.get("grep")!.parameters as any).properties).sort();

  assert.deepEqual(findKeys, ["limit", "path", "pattern"]);
  assert.deepEqual(grepKeys, ["context", "glob", "ignoreCase", "limit", "literal", "path", "pattern"]);
  assert.deepEqual(activeTools, ["read", "find", "grep"]);
  assert.equal(tools.has("ls"), false);
});
