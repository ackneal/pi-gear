import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatDoctor } from "../../commands/doctor.ts";
import { setupSandbox } from "./index.ts";

const enabled = {
  configured: true,
  enabled: true,
  workspace: "/workspace",
  reason: undefined,
  network: { allowedDomains: ["github.com"], deniedDomains: [], strictAllowlist: false },
} as const;

test("doctor reports only actionable sandbox diagnostics", () => {
  const output = formatDoctor(enabled, [], [], "darwin");
  assert.equal(output, [
    "Sandbox: enabled",
    "Platform: darwin",
    "Workspace: /workspace",
    "Bash: sandboxed",
    "Filesystem: read/edit/write guarded",
    "Network allow: github.com",
    "Network deny: (none)",
    "Network other hosts: require approval",
    "",
    "Subagents:",
  ].join("\n"));
  assert.doesNotMatch(output, /TOKEN|SECRET|KEY|env/i);
});

test("doctor includes the failure reason when sandbox is unavailable", () => {
  const output = formatDoctor({ configured: true, enabled: false, workspace: "unavailable", reason: "sandbox dependency missing", network: undefined }, [], [], "darwin");
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

  const diagnostics = setupSandbox(pi, {
    version: 1,
    sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
    filesystem: { rules: [] },
  });

  assert.equal(registeredCommand, false);
  assert.match(diagnostics.status().reason ?? "", /starting/);
});

test("disabled sandbox leaves Bash untouched, does not create a controller, and warns once per interactive session", async () => {
  const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
  const notifications: string[] = [];
  let controllers = 0;
  let registeredTools = 0;
  const pi = {
    on: (event: string, handler: (event: unknown, ctx: any) => unknown) => {
      const entries = handlers.get(event) ?? [];
      entries.push(handler);
      handlers.set(event, entries);
    },
    registerTool: () => { registeredTools += 1; },
  } as unknown as ExtensionAPI;

  const diagnostics = setupSandbox(pi, {
    version: 1,
    sandbox: { enabled: false, network: { rules: [], strictAllowlist: false } },
    filesystem: { rules: [] },
  }, { createController: () => { controllers += 1; throw new Error("must not create controller"); } });

  assert.equal(controllers, 0);
  assert.equal(registeredTools, 0);
  assert.equal(handlers.has("user_bash"), false);
  assert.equal(handlers.has("session_shutdown"), false);
  assert.equal(diagnostics.status().configured, false);

  const start = handlers.get("session_start")?.[0];
  assert.ok(start);
  await start({}, { hasUI: true, ui: { notify: (message: string) => notifications.push(message) } });
  assert.deepEqual(notifications, ["pi-gear sandbox is disabled. Bash commands run directly on the host."]);

  await start({}, { hasUI: false, ui: { notify: () => { throw new Error("headless notification"); } } });
  assert.equal(notifications.length, 1);
});

test("doctor reports disabled sandbox separately from unavailable", () => {
  const output = formatDoctor({ configured: false, enabled: false, workspace: "host", reason: undefined, network: undefined }, [], [], "darwin");
  assert.match(output, /^Sandbox: disabled by configuration\nPlatform: darwin/);
  assert.match(output, /Bash: host \(sandbox disabled\)/);
  assert.match(output, /Network: not applied; Bash runs on the host/);
  assert.doesNotMatch(output, /Reason:/);
});
