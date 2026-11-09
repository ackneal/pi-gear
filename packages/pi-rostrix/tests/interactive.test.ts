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
  let selectChoice: string | undefined = undefined;

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
      select: async (_title: string, options: string[]) => {
        return selectChoice !== undefined ? selectChoice : options[0];
      },
    },
  };

  return {
    pi,
    mockCtx,
    registeredShortcuts,
    registeredCommands,
    statuses,
    notifications,
    setSelectChoice: (choice: string | undefined) => {
      selectChoice = choice;
    },
  };
}

describe("Interactive Profile Cycling & Commands", () => {
  test("registers /agent and /profile command, and registers shortcut only when configured", () => {
    const { pi, registeredShortcuts, registeredCommands } = createMockExtensionApi();
    const runtime = initRostrix(pi, {
      autoRegisterTools: false,
      autoLoadProfiles: false,
      autoRegisterInteractive: false,
    });

    setupInteractiveProfiles({ pi, runtime });

    assert.equal(registeredShortcuts.size, 0, "No shortcuts registered by default");
    assert.ok(registeredCommands.has("profile"), "/profile command must be registered");
    assert.ok(registeredCommands.has("agent"), "/agent alias command must be registered");

    // When shortcut is explicitly passed
    setupInteractiveProfiles({ pi, runtime, shortcut: "alt+a" });
    assert.ok(registeredShortcuts.has("alt+a"), "Explicit shortcut must be registered");

    runtime.dispose();
  });

  test("/agent command with no arguments opens interactive picker and updates rostrix:agent status", async () => {
    const { pi, mockCtx, registeredCommands, statuses, notifications, setSelectChoice } = createMockExtensionApi();
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
    runtime.registerAgent(reviewerAgent);
    runtime.registerAgent(analystAgent);

    const cmd = registeredCommands.get("agent");
    assert.ok(cmd);

    // Initial state: default (activeAgent undefined)
    assert.equal(runtime.getActiveAgent(), undefined);

    // Step 1: select custom-reviewer from menu
    setSelectChoice("custom-reviewer - Code Reviewer");
    await cmd.handler("", mockCtx);
    assert.equal(runtime.getActiveAgent()?.id, "custom-reviewer");
    assert.equal(statuses.get("rostrix:agent"), "👤 Code Reviewer");
    assert.ok(notifications.some((n) => n.message.includes("Code Reviewer")));
    assert.deepEqual(pi.getActiveTools().sort(), ["bash", "read"].sort());

    // Step 2: select custom-analyst from menu
    setSelectChoice("custom-analyst - Data Analyst");
    await cmd.handler("", mockCtx);
    assert.equal(runtime.getActiveAgent()?.id, "custom-analyst");
    assert.equal(statuses.get("rostrix:agent"), "👤 Data Analyst");
    assert.deepEqual(pi.getActiveTools(), ["read"]);

    // Step 3: select default (unrestricted)
    setSelectChoice("default");
    await cmd.handler("", mockCtx);
    assert.equal(runtime.getActiveAgent(), undefined);
    assert.equal(statuses.get("rostrix:agent"), "");
    assert.ok(notifications.some((n) => n.message.includes("default (unrestricted)")));
    assert.deepEqual(pi.getActiveTools().sort(), ["bash", "edit", "read", "write"].sort());

    runtime.dispose();
  });

  test("/agent notifies when no directory agents are found", async () => {
    const { pi, mockCtx, registeredCommands, notifications } = createMockExtensionApi();
    const runtime = initRostrix(pi, {
      autoRegisterTools: false,
      autoLoadProfiles: false,
      autoRegisterInteractive: false,
    });

    setupInteractiveProfiles({ pi, runtime });

    const cmd = registeredCommands.get("agent");
    assert.ok(cmd);
    await cmd.handler("", mockCtx);

    assert.ok(notifications.some((n) => n.message.includes("No agents found") && n.type === "warning"));
    assert.equal(runtime.getActiveAgent(), undefined);

    runtime.dispose();
  });

  test("/profile command allows direct switching by ID and resetting via default", async () => {
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

    // Switch to doc-writer directly by ID
    await cmd.handler("doc-writer", mockCtx);
    assert.equal(runtime.getActiveProfile()?.id, "doc-writer");
    assert.equal(statuses.get("rostrix:agent"), "👤 Doc Writer");

    // Switch to default via /profile default
    await cmd.handler("default", mockCtx);
    assert.equal(runtime.getActiveProfile(), undefined);
    assert.equal(statuses.get("rostrix:agent"), "");

    runtime.dispose();
  });
});
