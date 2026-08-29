import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { FilesystemAccess } from "../execution/filesystem/access.ts";
import type { FffClient } from "../lifecycle/fff-client.ts";
import { WorkspaceSearch } from "./service.ts";
import { registerWorkspaceTools } from "./tools.ts";

const item = (relativePath: string) => ({ relativePath, fileName: relativePath, size: 1, modified: 1, accessFrecencyScore: 0, modificationFrecencyScore: 0, totalFrecencyScore: 0, gitStatus: "clean" });
const match = (relativePath: string, lineContent: string) => ({ ...item(relativePath), isBinary: false, lineNumber: 1, col: 0, byteOffset: 0, lineContent, matchRanges: [] });

async function setup(accessOverride?: Partial<FilesystemAccess>) {
  let grepPage = 0;
  const client = {
    request: async (method: string) => {
      if (method === "glob") return { items: [item(".env"), item("src/allowed.ts")], scores: [], totalMatched: 2, totalFiles: 2 };
      if (method === "grep") return ++grepPage === 1
        ? { items: [match(".env", "secret")], nextCursor: { __brand: "GrepCursor", _offset: 1 } }
        : { items: [match("src/allowed.ts", "visible")], nextCursor: null };
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
  return { tools, activeTools, grepPages: () => grepPage };
}

const run = (tool: ToolDefinition, input: Record<string, unknown>) => tool.execute("id", input, undefined, undefined, { cwd: process.cwd(), hasUI: false } as never);
const text = async (result: ReturnType<typeof run>) => (await result).content.map((part) => part.type === "text" ? part.text : "").join("\n");

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

test("external search roots are rejected by policy before either backend runs", async () => {
  const requests: string[] = [];
  const { tools } = await setup({
    request: async (_path, _operation, label) => {
      requests.push(label);
      return { path: "/outside", canonicalPath: "/outside", withinWorkspace: false, decision: "deny" };
    },
  });

  for (const name of ["find", "grep"] as const) {
    await assert.rejects(run(tools.get(name)!, { pattern: "needle", path: "/outside" }), /Access is not permitted/);
  }
  assert.deepEqual(requests, ["find", "grep"]);
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
