import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDoctor } from "./doctor.ts";
import { GEAR_COMMANDS, setupCommands, type GearCommandServices } from "./index.ts";

const sandboxStatus = {
  enabled: true,
  workspace: "/workspace",
  reason: undefined,
  network: { allowedDomains: [], deniedDomains: [] },
} as const;

test("doctor reports active subagents and their resolved model settings", () => {
  const output = formatDoctor(
    sandboxStatus,
    [
      { id: "researcher", mode: "inherit", dispatch: { model: "main/model-a", thinkingLevel: "low" } },
      { id: "worker", mode: "override", dispatch: { model: "provider/model-b", thinkingLevel: "high" } },
    ],
    ["researcher"],
    "darwin",
  );

  assert.match(output, /- researcher: enabled · inherit · \(main\) model-a • low/);
  assert.match(output, /- worker: disabled · override · \(provider\) model-b • high/);
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
    subagents: {
      inspect: async (_ctx: unknown, id?: string) => { calls.push(`inspect:${id ?? ""}`); },
      settings: {
        configure: async (args: string) => { calls.push(`model:${args}`); },
        resolve: () => ({}),
        summaries: () => [],
      },
    },
  } as unknown as GearCommandServices;
  const ctx = { ui: { notify: (message: string) => { calls.push(`doctor:${message.split("\n")[0]}`); } } };

  setupCommands(pi, services);

  assert.deepEqual([...commands.keys()].sort(), Object.values(GEAR_COMMANDS).sort());
  await commands.get(GEAR_COMMANDS.subagentInspect)?.handler(" call-1 ", ctx);
  await commands.get(GEAR_COMMANDS.subagentModel)?.handler("worker", ctx);
  await commands.get(GEAR_COMMANDS.doctor)?.handler("", ctx);
  assert.deepEqual(calls, ["inspect:call-1", "model:worker", "doctor:Sandbox: enabled"]);
});
