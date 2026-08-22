import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDoctor } from "../../commands/doctor.ts";
import { setupSandbox } from "./index.ts";

const enabled = {
  enabled: true,
  workspace: "/workspace",
  reason: undefined,
  network: { allowedDomains: ["github.com"], deniedDomains: [] },
} as const;

test("doctor reports only actionable sandbox diagnostics", () => {
  const output = formatDoctor(enabled, [], [], "darwin");
  assert.equal(output, [
    "Sandbox: enabled",
    "Platform: darwin",
    "Workspace: /workspace",
    "Filesystem: read/edit/write guarded; other tools warn when unguarded",
    "Network allow: github.com",
    "Network deny: (none)",
    "Network other hosts: require approval",
    "",
    "Subagents:",
  ].join("\n"));
  assert.doesNotMatch(output, /TOKEN|SECRET|KEY|env/i);
});

test("doctor includes the failure reason when sandbox is unavailable", () => {
  const output = formatDoctor({ enabled: false, workspace: "unavailable", reason: "sandbox dependency missing", network: undefined }, [], [], "darwin");
  assert.match(output, /^Sandbox: unavailable\nReason: sandbox dependency missing\nPlatform: darwin/);
});

test("sandbox exposes diagnostics without owning commands", () => {
  let registeredCommand = false;
  const pi = {
    on: () => undefined,
    registerTool: () => undefined,
    registerCommand: () => { registeredCommand = true; },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;

  const diagnostics = setupSandbox(pi);

  assert.equal(registeredCommand, false);
  assert.match(diagnostics.status().reason ?? "", /starting/);
});
