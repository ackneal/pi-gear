import test, { describe } from "node:test";
import assert from "node:assert/strict";
import { setupInteractiveProfiles } from "../src/interactive/index.ts";
import { initRostrix } from "../src/index.ts";

function createMockExtensionApi() {
  const registeredShortcuts = new Map<string, any>();
  const registeredCommands = new Map<string, any>();
  const statuses = new Map<string, string>();
  const notifications: { message: string; type?: string | undefined }[] = [];
  const events = new Map<string, Function[]>();
  let activeTools = ["read", "write", "edit", "bash"];

  const pi: any = {
    registerShortcut(shortcut: string, options: any) {
      registeredShortcuts.set(shortcut, options);
    },
    registerCommand(name: string, options: any) {
      registeredCommands.set(name, options);
    },
    getActiveTools() {
      return [...activeTools];
    },
    getAllTools() {
      return [
        { name: "read" },
        { name: "write" },
        { name: "edit" },
        { name: "bash" },
      ];
    },
    setActiveTools(tools: string[]) {
      activeTools = [...tools];
    },
    on(event: string, handler: Function) {
      const list = events.get(event) ?? [];
      list.push(handler);
      events.set(event, list);
      return () => {
        const idx = list.indexOf(handler);
        if (idx >= 0) list.splice(idx, 1);
      };
    },
    emit(event: string, data: any) {
      const list = events.get(event) ?? [];
      for (const h of list) h(data);
    },
  };

  const mockCtx = {
    hasUI: true,
    ui: {
      setStatus(key: string, text: string) {
        statuses.set(key, text);
      },
      notify(msg: string, type?: string) {
        notifications.push({ message: msg, type });
      },
      select: async (_title: string, _options: string[]) => undefined,
    },
  };

  return { pi, mockCtx, registeredShortcuts, registeredCommands, statuses, notifications };
}

describe("Interactive Profile Cycling & Commands", () => {
  test("registers ctrl+r shortcut and /profile command", () => {
    const { pi, registeredShortcuts, registeredCommands } = createMockExtensionApi();
    const runtime = initRostrix(pi, {
      autoRegisterTools: false,
      autoLoadProfiles: false,
      autoRegisterInteractive: false,
    });

    setupInteractiveProfiles({ pi, runtime });

    assert.ok(registeredShortcuts.has("ctrl+r"), "ctrl+r shortcut must be registered");
    assert.ok(registeredCommands.has("profile"), "/profile command must be registered");
    assert.ok(registeredCommands.has("agent"), "/agent alias command must be registered");

    runtime.dispose();
  });

  test("ctrl+r cycles strictly through file-discovered profiles and default, ignoring api-registered profiles", async () => {
    const { pi, mockCtx, registeredShortcuts, statuses, notifications } = createMockExtensionApi();
    const runtime = initRostrix(pi, {
      autoRegisterTools: false,
      autoLoadProfiles: false,
      autoRegisterInteractive: false,
    });

    setupInteractiveProfiles({ pi, runtime });

    // 1. Register an API-only profile (like gear:worker) -> should NOT be cycled
    runtime.registerProfile({
      id: "gear:worker",
      label: "Gear Worker",
      description: "Background worker subagent",
    });

    // 2. Mock discovered file profiles (e.g. from ~/.pi/agent/rostrix)
    const reviewerAgent = {
      id: "custom-reviewer",
      label: "Code Reviewer",
      description: "Read-only reviewer",
      tools: { allow: ["read", "bash"], deny: ["edit", "write"] },
    };
    const analystAgent = {
      id: "custom-analyst",
      label: "Data Analyst",
      description: "Metrics analyst",
      tools: { allow: ["read"] },
    };

    (runtime as any)._discoveredAgents = [
      {
        agent: reviewerAgent,
        profile: reviewerAgent,
        filePath: "/user/profiles/reviewer.md",
        scope: "user",
      },
      {
        agent: analystAgent,
        profile: analystAgent,
        filePath: "/user/profiles/analyst.md",
        scope: "user",
      },
    ];
    // Register them in registry so resolver can find them
    runtime.registerAgent(reviewerAgent);
    runtime.registerAgent(analystAgent);

    const shortcut = registeredShortcuts.get("ctrl+r");
    assert.ok(shortcut);

    // Initial state: default (activeProfile undefined)
    assert.equal(runtime.getActiveProfile(), undefined);

    // Press 1: cycles to custom-reviewer
    await shortcut.handler(mockCtx);
    assert.equal(runtime.getActiveProfile()?.id, "custom-reviewer");
    assert.equal(statuses.get("rostrix:profile"), "👤 Code Reviewer");
    assert.ok(notifications.some((n) => n.message.includes("Code Reviewer")));
    // Verified tools restricted: edit and write removed
    assert.deepEqual(pi.getActiveTools().sort(), ["bash", "read"].sort());

    // Press 2: cycles to custom-analyst (SKIPPING gear:worker!)
    await shortcut.handler(mockCtx);
    assert.equal(runtime.getActiveProfile()?.id, "custom-analyst");
    assert.equal(statuses.get("rostrix:profile"), "👤 Data Analyst");
    assert.deepEqual(pi.getActiveTools(), ["read"]);

    // Press 3: cycles back to default
    await shortcut.handler(mockCtx);
    assert.equal(runtime.getActiveProfile(), undefined);
    assert.equal(statuses.get("rostrix:profile"), "");
    assert.ok(notifications.some((n) => n.message.includes("default (unrestricted)")));
    // Verified all tools restored
    assert.deepEqual(pi.getActiveTools().sort(), ["bash", "edit", "read", "write"].sort());

    runtime.dispose();
  });

  test("ctrl+r notifies when no directory profiles are found", async () => {
    const { pi, mockCtx, registeredShortcuts, notifications } = createMockExtensionApi();
    const runtime = initRostrix(pi, {
      autoRegisterTools: false,
      autoLoadProfiles: false,
      autoRegisterInteractive: false,
    });

    setupInteractiveProfiles({ pi, runtime });

    const shortcut = registeredShortcuts.get("ctrl+r");
    await shortcut.handler(mockCtx);

    assert.ok(notifications.some((n) => (n.message.includes("No agents found") || n.message.includes("No profiles found")) && n.type === "warning"));
    assert.equal(runtime.getActiveProfile(), undefined);

    runtime.dispose();
  });

  test("/profile command allows direct switching and resetting", async () => {
    const { pi, mockCtx, registeredCommands, statuses } = createMockExtensionApi();
    const runtime = initRostrix(pi, {
      autoRegisterTools: false,
      autoLoadProfiles: false,
      autoRegisterInteractive: false,
    });

    setupInteractiveProfiles({ pi, runtime });

    const profileDef = {
      id: "doc-writer",
      label: "Doc Writer",
      description: "Documentation specialist",
      tools: { allow: ["read", "write"] },
    };
    (runtime as any)._discoveredAgents = [
      { agent: profileDef, profile: profileDef, filePath: "/profiles/doc-writer.md", scope: "project" },
    ];
    runtime.registerProfile(profileDef);

    const cmd = registeredCommands.get("profile");
    assert.ok(cmd);

    // Switch to doc-writer
    await cmd.handler("doc-writer", mockCtx);
    assert.equal(runtime.getActiveProfile()?.id, "doc-writer");
    assert.equal(statuses.get("rostrix:profile"), "👤 Doc Writer");

    // Switch to default via /profile default
    await cmd.handler("default", mockCtx);
    assert.equal(runtime.getActiveProfile(), undefined);
    assert.equal(statuses.get("rostrix:profile"), "");

    runtime.dispose();
  });
});
