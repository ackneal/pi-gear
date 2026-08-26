import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { childArgs } from "../../runtime/process.ts";
import type { SubagentRun } from "../../runtime/types.ts";
import { WORKER_CAPABILITIES, workerProfile } from "./profile.ts";
import { WORKER_SYSTEM_PROMPT } from "./prompt.ts";
import workerExtension from "./extension.ts";
import { formatWorkerInput, WORKER_TOOL_NAME, runWorker } from "./index.ts";
import type { WorkerSubagentInput } from "./index.ts";
import { setupSubagents } from "../../index.ts";

test("worker profile, prompt, and capabilities match specification", () => {
  assert.equal(WORKER_TOOL_NAME, "worker");
  assert.equal(workerProfile.id, "worker");
  assert.equal(workerProfile.label, "worker");
  assert.equal(workerProfile.description, "Delegate one of several disjoint tasks for parallel execution.");
  assert.equal(workerProfile.systemPrompt, WORKER_SYSTEM_PROMPT);
  assert.match(WORKER_SYSTEM_PROMPT, /only the delegated scope/);
  assert.match(WORKER_SYSTEM_PROMPT, /authoritative code and types/);
  assert.match(WORKER_SYSTEM_PROMPT, /focused checks/);
  assert.match(WORKER_SYSTEM_PROMPT, /changed, disproven, or blocked/);
  assert.deepEqual(workerProfile.capabilities, WORKER_CAPABILITIES);
  assert.deepEqual(WORKER_CAPABILITIES, [
    { kind: "builtin", name: "read" },
    { kind: "builtin", name: "edit" },
    { kind: "builtin", name: "write" },
    { kind: "builtin", name: "bash" },
  ]);
  assert.deepEqual(workerProfile.presentation, {
    activity: {
      starting: "Working",
      complete: "Work complete",
      drafting: "Preparing result",
      failed: "Work failed",
      aborted: "Work aborted",
    },
  });
});

test("worker child arguments configure isolation, capabilities, and system prompt", () => {
  const extensionUrl = new URL("./extension.ts", import.meta.url);
  const args = childArgs(workerProfile, "implement feature", extensionUrl);
  assert.ok(
    args.includes("--no-session") &&
    args.includes("--no-extensions") &&
    args.includes("--no-skills") &&
    args.includes("--no-context-files") &&
    args.includes("--no-prompt-templates"),
  );
  assert.equal(args[args.indexOf("--tools") + 1], "read,edit,write,bash");
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], WORKER_SYSTEM_PROMPT);
  assert.equal(args[args.indexOf("--extension") + 1]?.endsWith("subagents/agents/worker/extension.ts"), true);
  assert.equal(args[args.length - 1], "implement feature");
});

test("worker extension configures filesystem guard and sandbox", async () => {
  const registeredTools: string[] = [];
  const registeredCommands: string[] = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: { cwd: string }) => unknown>>();

  const mockPi = {
    registerTool: (tool: { name: string }) => { registeredTools.push(tool.name); },
    registerCommand: (name: string) => { registeredCommands.push(name); },
    on: (event: string, handler: (event: unknown, ctx: { cwd: string }) => unknown) => {
      const eventHandlers = handlers.get(event) ?? [];
      eventHandlers.push(handler);
      handlers.set(event, eventHandlers);
    },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;

  await workerExtension(mockPi, async () => ({
    version: 1,
    filesystem: { rules: [] },
    sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
  }));
  handlers.get("session_start")?.at(-1)?.({}, { cwd: "/workspace" });

  assert.ok(handlers.has("tool_call")); // filesystem guard
  assert.ok(handlers.has("session_start")); // sandbox
  assert.deepEqual(registeredCommands, []); // child runtime exposes no user commands
  assert.ok(registeredTools.includes("bash")); // sandbox bash
});

test("setupSubagents registers asynchronous subagent and control tools", async () => {
  const tools = new Map<string, {
    label: string;
    description: string;
    executionMode: string;
    execute: (id: string, args: { task: string }, signal: AbortSignal | undefined, onUpdate: (update: unknown) => void, ctx: { cwd: string }) => Promise<unknown>;
  }>();
  const handlers = new Map<string, Array<(event: unknown) => unknown>>();

  const mockPi = {
    registerTool: (tool: {
      name: string;
      label: string;
      description: string;
      executionMode: string;
      execute: (id: string, args: { task: string }, signal: AbortSignal | undefined, onUpdate: (update: unknown) => void, ctx: { cwd: string }) => Promise<unknown>;
    }) => {
      tools.set(tool.name, tool);
    },
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI;

  setupSubagents(mockPi);

  assert.deepEqual([...tools.keys()], ["researcher", "worker", "subagent_observe", "subagent_cancel"]);

  assert.match(tools.get("researcher")?.description ?? "", /Start focused read-only research/);
  assert.match(tools.get("researcher")?.description ?? "", /Returns immediately with a runId/);

  const workerTool = tools.get("worker")!;
  assert.equal(workerTool.label, "worker");
  assert.equal(workerTool.executionMode, "parallel");
  assert.match(workerTool.description, /Returns immediately with a runId/);
  assert.match(workerTool.description, /Set targetFiles when files may be modified/);
  assert.match(tools.get("subagent_observe")?.description ?? "", /meaningful subagent progress, completion, or a bounded timeout/);
  assert.match(tools.get("subagent_observe")?.description ?? "", /subagent keeps running/);
  assert.match(tools.get("subagent_cancel")?.description ?? "", /Other runs and the main agent continue/);
  assert.match(tools.get("subagent_cancel")?.description ?? "", /repeated cancellation returns the same terminal state/);
});

test("formatWorkerInput serializes structured fields into the child user input", () => {
  const brief = formatWorkerInput({
    task: "build feature",
    targetFiles: ["src/a.ts", "src/b.ts"],
    findings: "the interval is already wired",
    verification: "npm test",
  });
  assert.match(brief, /Task: build feature/);
  assert.match(brief, /Target files:\n- src\/a\.ts\n- src\/b\.ts/);
  assert.match(brief, /Findings: the interval is already wired/);
  assert.match(brief, /Verification: npm test/);

  const minimal = formatWorkerInput({
    task: "just do it",
    targetFiles: undefined,
    findings: undefined,
    verification: undefined,
  } satisfies WorkerSubagentInput);
  assert.equal(minimal, "Task: just do it");
});

test("runWorker executes via child runner with worker profile and emits updates", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });

  const updates: SubagentRun[] = [];
  const brief = formatWorkerInput({
    task: "build feature",
    targetFiles: ["src/a.ts"],
    findings: "wired already",
    verification: "npm test",
  });
  const promise = runWorker(brief, {
    cwd: "/workspace",
    spawnChild: () => child as never,
    onUpdate: (update: SubagentRun) => {
      updates.push(update);
    },
  });

  child.stdout.emit(
    "data",
    Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"Implemented"}]}}\n'),
  );
  child.emit("close", 0);

  const result = await promise;
  assert.equal(result.status, "success");
  assert.equal(result.result, "Implemented");
  assert.ok(updates.length > 0);
});
