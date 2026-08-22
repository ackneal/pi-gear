import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDoctor, setupSandbox } from "./index.ts";

const enabled = {
  enabled: true,
  workspace: "/workspace",
  reason: undefined,
  network: { allowedDomains: ["github.com"], deniedDomains: [] },
} as const;

test("doctor reports only actionable sandbox diagnostics", () => {
  const output = formatDoctor(enabled, "darwin");
  assert.equal(output, [
    "Sandbox: enabled",
    "Platform: darwin",
    "Workspace: /workspace",
    "Filesystem: read/edit/write guarded; other tools warn when unguarded",
    "Network allow: github.com",
    "Network deny: (none)",
    "Network other hosts: require approval",
  ].join("\n"));
  assert.doesNotMatch(output, /TOKEN|SECRET|KEY|env/i);
});

test("doctor includes the failure reason when sandbox is unavailable", () => {
  const output = formatDoctor({ enabled: false, workspace: "unavailable", reason: "sandbox dependency missing", network: undefined }, "darwin");
  assert.match(output, /^Sandbox: unavailable\nReason: sandbox dependency missing\nPlatform: darwin/);
});

test("setup registers doctor instead of the old sandbox command", async () => {
  let commandName: string | undefined;
  let commandHandler: ((args: string, ctx: { ui: { notify: (message: string, level: "info") => void } }) => Promise<void>) | undefined;
  const pi = {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: (name: string, command: { handler: typeof commandHandler }) => {
      commandName = name;
      commandHandler = command.handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  setupSandbox(pi);
  assert.equal(commandName, "doctor");
  assert.ok(commandHandler);

  let output = "";
  await commandHandler("", { ui: { notify: (message) => { output = message; } } });
  assert.match(output, /^Sandbox: unavailable\nReason: starting/);
});
