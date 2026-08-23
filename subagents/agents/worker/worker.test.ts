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

test("worker extension configures filesystem guard and sandbox", () => {
  const registeredTools: string[] = [];
  const registeredCommands: string[] = [];
  const registeredEvents: string[] = [];

  const mockPi = {
    registerTool: (tool: { name: string }) => { registeredTools.push(tool.name); },
    registerCommand: (name: string) => { registeredCommands.push(name); },
    on: (event: string) => { registeredEvents.push(event); },
    sendMessage: () => {},
  } as unknown as ExtensionAPI;

  workerExtension(mockPi);

  assert.ok(registeredEvents.includes("tool_call")); // filesystem guard
  assert.ok(registeredEvents.includes("session_start")); // sandbox
  assert.deepEqual(registeredCommands, []); // child runtime exposes no user commands
  assert.ok(registeredTools.includes("bash")); // sandbox bash
});

test("setupSubagents registers researcher and worker tools", async () => {
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

  assert.ok(tools.has("researcher"));
  assert.ok(tools.has("worker"));

  const workerTool = tools.get("worker")!;
  assert.equal(workerTool.label, "worker");
  assert.equal(workerTool.executionMode, "parallel");
  assert.equal(workerTool.description, "Delegate one of several disjoint tasks for parallel execution.");
});

test("setupSubagents flags failed subagent runs as tool errors", () => {
  const handlers = new Map<string, Array<(event: unknown) => unknown>>();
  const mockPi = {
    registerTool: () => {},
    registerCommand: () => {},
    on: (event: string, handler: (event: unknown) => unknown) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;

  setupSubagents(mockPi);

  const onToolResult = handlers.get("tool_result")?.[0];
  assert.ok(onToolResult);
  const rows = [
    { toolName: "worker", run: { status: "error" }, expected: { isError: true } },
    { toolName: "researcher", run: { status: "aborted" }, expected: { isError: true } },
    { toolName: "worker", run: { status: "success", result: "done" }, expected: undefined },
    { toolName: "read", run: { status: "error" }, expected: undefined },
  ] as const;
  for (const { toolName, run, expected } of rows) {
    const result = onToolResult({ type: "tool_result", toolCallId: "t1", input: {}, content: [], isError: false, toolName, details: run });
    assert.deepEqual(result, expected, `${toolName}/${run.status}`);
  }
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
