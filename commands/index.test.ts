import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDoctor } from "./doctor.ts";
import { GEAR_COMMANDS, setupCommands, type GearCommandServices } from "./index.ts";

const sandboxStatus = {
  configured: true,
  enabled: true,
  workspace: "/workspace",
  reason: undefined,
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: false },
} as const;

test("doctor reports active subagents and their resolved model settings", () => {
  const output = formatDoctor(
    sandboxStatus,
    [
      { id: "researcher", mode: "inherit", source: "main", dispatch: { model: "main/model-a", thinkingLevel: "low" }, available: true },
      { id: "worker", mode: "override", source: "runtime", dispatch: { model: "provider/model-b", thinkingLevel: "high" }, available: false },
    ],
    ["researcher"],
    "darwin",
    "invalid JSON",
  );

  assert.match(output, /Runtime config: invalid · invalid JSON/);
  assert.match(output, /- researcher: enabled · main inherit · \(main\) model-a • low/);
  assert.match(output, /- worker: disabled · runtime override · \(provider\) model-b • high · model unavailable/);
  assert.doesNotMatch(output, /\nLSP:/);
});

test("doctor formats configured LSP server statuses", () => {
  const output = formatDoctor(
    sandboxStatus,
    [],
    [],
    "linux",
    undefined,
    [
      { extensions: [".ts", ".tsx"], executable: "typescript-language-server", available: true, running: true },
      { extensions: [".py"], executable: "pyright-langserver", available: true, running: false },
      { extensions: [".rs"], executable: "rust-analyzer", available: false, running: false },
    ],
  );

  assert.equal(output, [
    "Sandbox: enabled",
    "Platform: linux",
    "Workspace: /workspace",
    "Bash: sandboxed",
    "Filesystem: read/edit/write guarded",
    "Network allow: (none)",
    "Network deny: (none)",
    "Network other hosts: require approval",
    "",
    "Subagents:",
    "",
    "LSP:",
    "- running .ts .tsx · typescript-language-server",
    "- available .py · pyright-langserver",
    "- not found .rs · rust-analyzer",
  ].join("\n"));
});

test("gear commands are centrally registered and delegate to their services", async () => {
  const commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const calls: string[] = [];
  const pi = {
    registerCommand: (name: string, definition: { handler: (args: string, ctx: any) => Promise<void> }) => {
      commands.set(name, definition);
    },
    getActiveTools: () => ["researcher", "worker"],
  } as unknown as ExtensionAPI;
  const services = {
    execution: { sandbox: { status: () => sandboxStatus } },
    lsp: { statuses: async (cwd: string) => { calls.push(`lsp:${cwd}`); return []; } },
    subagents: {
      inspect: async (_ctx: unknown, id?: string) => { calls.push(`inspect:${id ?? ""}`); },
      settings: {
        configure: async (args: string) => { calls.push(`model:${args}`); },
        resolve: () => ({}),
        summaries: () => [],
        runtimeError: () => undefined,
      },
    },
  } as unknown as GearCommandServices;
  const ctx = { cwd: "/workspace", ui: { notify: (message: string) => { calls.push(`doctor:${message.split("\n")[0]}`); } } };

  setupCommands(pi, services);

  assert.deepEqual([...commands.keys()].sort(), Object.values(GEAR_COMMANDS).sort());
  await commands.get(GEAR_COMMANDS.subagentInspect)?.handler(" call-1 ", ctx);
  await commands.get(GEAR_COMMANDS.subagentModel)?.handler("worker", ctx);
  await commands.get(GEAR_COMMANDS.doctor)?.handler("", ctx);
  assert.deepEqual(calls, ["inspect:call-1", "model:worker", "lsp:/workspace", "doctor:Sandbox: enabled"]);
});
