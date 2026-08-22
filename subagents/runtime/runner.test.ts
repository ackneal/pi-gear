import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { PiJsonDecoder } from "./protocol.ts";
import { reduceSubagentEvent } from "./state.ts";
import { runChildSubagent } from "./runner.ts";
import { childArgs, resolvePiInvocation, spawnPiChild } from "./process.ts";
import { MAX_DECODER_BUFFER_CHARS, MAX_RETAINED_ITEMS, MAX_RETAINED_TEXT_CHARS, TRUNCATION_MARKER } from "./limits.ts";
import type { SubagentProfile } from "./types.ts";
import type { SubagentRun } from "./types.ts";
import { researcherProfile } from "../agents/researcher/profile.ts";
import { RESEARCHER_SYSTEM_PROMPT } from "../agents/researcher/prompt.ts";

const profile: SubagentProfile = { id: "test", label: "test", description: "test", systemPrompt: "test", capabilities: [{ kind: "builtin", name: "read" }] };

function decodeMessage(...texts: string[]) {
  const event = {
    type: "message_end",
    message: {
      role: "assistant",
      content: texts.map((text) => ({ type: "text", text })),
    },
  };
  return new PiJsonDecoder().push(`${JSON.stringify(event)}\n`);
}

test("protocol handles fragmented JSON, trailing data, malformed diagnostics, and duplicate starts", () => {
  const decoder = new PiJsonDecoder();
  assert.deepEqual(decoder.push('{"type":"tool_execution_start","toolCallId":"x","toolName":"read"}\n{"bad"'), [{ type: "tool_start", id: "x", name: "read" }]);
  assert.equal(decoder.push('', true)[0]?.type, "diagnostic");

  let run: SubagentRun = { status: "running", startedAt: 0, lastActivityAt: 0, items: [] };
  run = reduceSubagentEvent(run, { type: "tool_start", id: "x", name: "read" }, 1_000);
  assert.equal(run.lastActivityAt, 1_000);
  run = reduceSubagentEvent(run, { type: "tool_start", id: "x", name: "read" }, 2_000);
  assert.equal(run.lastActivityAt, 2_000);
  run = reduceSubagentEvent(run, { type: "diagnostic", message: "warn" }, 3_000);
  assert.equal(run.lastActivityAt, 2_000);
  run = reduceSubagentEvent(run, { type: "tool_end", id: "x", isError: false, result: "ok" }, 4_000);
  assert.equal(run.lastActivityAt, 4_000);
  assert.deepEqual(run.items, [{ kind: "tool", id: "x", name: "read", status: "success", result: "ok" }]);
  run = reduceSubagentEvent(run, { type: "thinking", text: "hmm" }, 5_000);
  assert.equal(run.lastActivityAt, 5_000);
  run = reduceSubagentEvent(run, { type: "result", text: "done" }, 6_000);
  assert.equal(run.lastActivityAt, 6_000);
  assert.equal(run.result, "done");
});

test("resolver follows official script, generic, Bun virtual, and packaged paths", () => {
  assert.deepEqual(resolvePiInvocation({ argv: ["node", "/app/pi.js"], execPath: "/node", exists: () => true }), { command: "/node", prefixArgs: ["/app/pi.js"] });
  assert.deepEqual(resolvePiInvocation({ argv: ["bun", "/$bunfs/root/pi.js"], execPath: "/bun", exists: () => true }), { command: "pi", prefixArgs: [] });
  assert.deepEqual(resolvePiInvocation({ argv: ["node", "/missing"], execPath: "/node", exists: () => false }), { command: "pi", prefixArgs: [] });
  assert.deepEqual(resolvePiInvocation({ argv: ["pi"], execPath: "/Applications/pi", exists: () => false }), { command: "/Applications/pi", prefixArgs: [] });
});

test("child process inherits the active session cwd", () => {
  let receivedCwd: string | undefined;
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  spawnPiChild(profile, "inspect", new URL("./runner.test.ts", import.meta.url), ((_command: string, _args: readonly string[], options: { cwd?: string }) => {
    receivedCwd = options?.cwd;
    return child;
  }) as never, "/session/workspace");
  assert.equal(receivedCwd, "/session/workspace");
});

test("researcher child arguments isolate the child and use exactly its allowlist", () => {
  const args = childArgs(researcherProfile, "inspect", new URL("../agents/researcher/extension.ts", import.meta.url));
  assert.ok(
    args.includes("--no-session") &&
    args.includes("--no-extensions") &&
    args.includes("--no-skills") &&
    args.includes("--no-context-files") &&
    args.includes("--no-prompt-templates"),
  );
  assert.equal(args[args.indexOf("--extension") + 1]?.endsWith("subagents/agents/researcher/extension.ts"), true);
  assert.equal(args[args.indexOf("--tools") + 1], "read,exa_web_search_exa,exa_get_code_context_exa,exa_research_paper_exa,exa_crawling_exa,context7_resolve_library_id,context7_query_docs,gh_grep_searchGitHub");
  assert.equal(args.join(",").match(/\b(?:bash|edit|write)\b/), null);
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], RESEARCHER_SYSTEM_PROMPT);
});

test("decoder and reducer bound retained data and aggregate multipart reports", () => {
  const decoder = new PiJsonDecoder();
  assert.equal(decoder.push("x".repeat(MAX_DECODER_BUFFER_CHARS + 1))[0]?.type, "diagnostic");
  const events = decodeMessage("one", "two");
  assert.deepEqual(events.filter((event) => event.type === "result"), [{ type: "result", text: "onetwo" }]);
  let run: SubagentRun = { status: "running", startedAt: 0, items: [] };
  for (let i = 0; i < MAX_RETAINED_ITEMS + 2; i++) run = reduceSubagentEvent(run, { type: "tool_start", id: `t_${i}`, name: "read" });
  assert.equal(run.items.length, MAX_RETAINED_ITEMS);
  run = reduceSubagentEvent(run, { type: "thinking", text: "x".repeat(MAX_RETAINED_TEXT_CHARS + 1) });
  const lastItem = run.items[run.items.length - 1];
  assert.ok(lastItem && lastItem.kind === "thinking" && lastItem.text.endsWith(TRUNCATION_MARKER));
});

test("decodes the checked-in Pi 0.84.1 JSON-mode transcript", async () => {
  const { readFile } = await import("node:fs/promises");
  const jsonl = await readFile(new URL("./fixtures/pi-0.84.1-json-mode.jsonl", import.meta.url), "utf8");
  const events = new PiJsonDecoder().push(jsonl, true);
  assert.ok(events.some((event) => event.type === "thinking" && event.text === "Inspecting code"));
  assert.ok(events.some((event) => event.type === "result" && event.text === "Final report"));
  assert.ok(events.some((event) => event.type === "tool_start" && event.id === "call_42"));
  assert.ok(events.some((event) => event.type === "tool_end" && event.id === "call_bad" && event.isError));
  assert.equal(events.filter((event) => event.type === "usage").length, 2);

  let run: SubagentRun = { status: "running", startedAt: 0, items: [] };
  for (const event of events) run = reduceSubagentEvent(run, event);
  assert.equal(run.result, "Final report");
  const failedTool = run.items.find((item) => item.kind === "tool" && item.id === "call_bad");
  assert.equal(failedTool?.kind === "tool" ? failedTool.status : undefined, "error");
  assert.equal(run.usage?.input, 150);
});

test("child returns a final report and rejects an empty successful result", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const result = runChildSubagent({ task: "inspect", profile, childExtension: new URL("./runner.test.ts", import.meta.url), spawnChild: () => child as never, onUpdate: () => {} });

  child.stdout.emit("data", Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"report"}]}}\n'));
  child.emit("close", 0);

  assert.equal((await result).status, "success");

  const empty = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const failed = runChildSubagent({ task: "inspect", profile, childExtension: new URL("./runner.test.ts", import.meta.url), spawnChild: () => empty as never, onUpdate: () => {} });

  empty.emit("close", 0);

  assert.match((await failed).error ?? "", /without a final report/);
});

test("error then close resolves once, while concurrent aborts stay isolated", async () => {
  const first = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  let updates = 0;
  const one = runChildSubagent({ task: "one", profile, childExtension: new URL("./runner.test.ts", import.meta.url), spawnChild: () => first as never, onUpdate: () => { updates++; } });

  first.emit("error", new Error("spawn failed"));
  first.emit("close", 1);

  assert.equal((await one).status, "error");
  assert.equal(updates, 1);

  const controller = new AbortController();
  const killed: string[] = [];
  const aborted = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: (signal: string) => { killed.push(signal); return true; } });
  const active = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const a = runChildSubagent({ task: "a", profile, signal: controller.signal, childExtension: new URL("./runner.test.ts", import.meta.url), spawnChild: () => aborted as never, onUpdate: () => {} });
  const b = runChildSubagent({ task: "b", profile, childExtension: new URL("./runner.test.ts", import.meta.url), spawnChild: () => active as never, onUpdate: () => {} });

  controller.abort();
  aborted.emit("close", 0);
  active.stdout.emit("data", Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"independent"}]}}\n'));
  active.emit("close", 0);

  assert.equal((await a).status, "aborted");
  assert.equal((await b).result, "independent");
  assert.deepEqual(killed, ["SIGTERM"]);
});

test("nonzero stderr is bounded and abort escalates then cleans listeners", async () => {
  const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
  const failed = runChildSubagent({ task: "fail", profile, childExtension: new URL("./runner.test.ts", import.meta.url), spawnChild: () => child as never, onUpdate: () => {} });

  child.stderr.emit("data", Buffer.from("x".repeat(MAX_RETAINED_TEXT_CHARS * 2)));
  child.emit("close", 2);

  assert.ok((await failed).error?.includes("[truncated]"));
  const controller = new AbortController();
  const signals: string[] = [];
  let timer: (() => void) | undefined;
  let cleared = false;
  const hanging = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: (signal: string) => { signals.push(signal); return true; } });
  const result = runChildSubagent({ task: "hang", profile, signal: controller.signal, childExtension: new URL("./runner.test.ts", import.meta.url), spawnChild: () => hanging as never, onUpdate: () => {}, setKillTimer: (callback) => { timer = callback; return 1 as never; }, clearKillTimer: () => { cleared = true; } });
  controller.abort();
  timer?.();

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);

  hanging.emit("close", 0);
  await result;

  assert.equal(cleared, true);
  assert.equal(hanging.listenerCount("error"), 0);
  assert.equal(hanging.listenerCount("close"), 0);
  assert.equal(hanging.stdout.listenerCount("data"), 0);
  assert.equal(hanging.stderr.listenerCount("data"), 0);
});

test("decoder emits usage only once from message_end", () => {
  const decoder = new PiJsonDecoder();
  const messageEndEvents = decoder.push(
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "report" }],
        usage: { input: 100, output: 50, cacheRead: 20, cacheWrite: 10, totalTokens: 180, cost: { total: 0.005, input: 0.001, output: 0.004 } },
      },
    }) + "\n",
  );
  assert.deepEqual(messageEndEvents, [
    { type: "result", text: "report" },
    {
      type: "usage",
      usage: {
        input: 100,
        output: 50,
        cacheRead: 20,
        cacheWrite: 10,
        totalTokens: 180,
        cost: { total: 0.005, input: 0.001, output: 0.004 },
      },
    },
  ]);

  const turnEndEvents = decoder.push(
    JSON.stringify({
      type: "turn_end",
      message: {
        role: "assistant",
        usage: { input: 50, output: 25 },
      },
    }) + "\n",
  );
  assert.deepEqual(turnEndEvents, []);

  const agentEndEvents = decoder.push(JSON.stringify({
    type: "agent_end",
    messages: [{ role: "assistant", content: [], usage: { input: 100, output: 50 } }],
  }) + "\n");
  assert.equal(agentEndEvents.some((event) => event.type === "usage"), false);
});

test("reduceSubagentEvent sums per-message usage and every numeric cost field", () => {
  let run: SubagentRun = { status: "running", startedAt: 0, lastActivityAt: 0, items: [] };
  const usage = {
    input: 1000,
    output: 500,
    cacheRead: 200,
    cacheWrite: 100,
    cacheWrite1h: 40,
    reasoning: 300,
    totalTokens: 1800,
    cost: { total: 1.5, input: 0.5, output: 1.0 },
  };

  run = reduceSubagentEvent(run, { type: "usage", usage }, 1_000);
  run = reduceSubagentEvent(run, { type: "usage", usage: {
    input: 20, output: 10, cacheRead: 5, cacheWrite: 2, cacheWrite1h: 1, reasoning: 4, totalTokens: 37,
    cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 },
  } }, 2_000);

  assert.deepEqual(run.usage, {
    input: 1020, output: 510, cacheRead: 205, cacheWrite: 102, cacheWrite1h: 41, reasoning: 304, totalTokens: 1837,
    cost: { input: 0.6, output: 1.2, cacheRead: 0.03, cacheWrite: 0.04, total: 1.87 },
  });
});

test("thinking deltas are incremental and accumulate into one retained item", () => {
  const decoder = new PiJsonDecoder();
  let run: SubagentRun = { status: "running", startedAt: 0, lastActivityAt: 0, items: [] };

  // thinking_delta "Hel" + thinking_delta "lo" must accumulate to "Hello"
  // in a single retained thinking item.
  decoder.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } }) + "\n");
  for (const delta of ["Hel", "lo"]) {
    const events = decoder.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta } }) + "\n");
    for (const ev of events) run = reduceSubagentEvent(run, ev);
  }
  assert.equal(run.items.length, 1);
  if (run.items[0]?.kind === "thinking") assert.equal(run.items[0].text, "Hello");

  // Block B: a new contentIndex creates a separate item.
  decoder.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 1 } }) + "\n");
  const events = decoder.push(JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "Another reasoning block" } }) + "\n");
  for (const ev of events) run = reduceSubagentEvent(run, ev);

  assert.deepEqual(run.items, [
    { kind: "thinking", text: "Hello", contentIndex: 0 },
    { kind: "thinking", text: "Another reasoning block", contentIndex: 1 },
  ]);
});

test("thinking content indexes are scoped to an assistant message", () => {
  const decoder = new PiJsonDecoder();
  let run: SubagentRun = { status: "running", startedAt: 0, items: [] };
  for (const text of ["first", "second"]) {
    const input = [
      { type: "message_start" },
      { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: text } },
      { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", text }] } },
    ].map((event) => JSON.stringify(event)).join("\n") + "\n";
    for (const event of decoder.push(input)) run = reduceSubagentEvent(run, event);
  }
  assert.deepEqual(run.items.map((item) => item.kind === "thinking" ? item.text : ""), ["first", "second"]);
});

test("decoder discards an oversized complete line without parsing it", () => {
  const decoder = new PiJsonDecoder();
  const oversized = JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(MAX_DECODER_BUFFER_CHARS) }] } });
  const events = decoder.push(oversized + "\n" + JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }) + "\n");
  assert.equal(events[0]?.type, "diagnostic");
  assert.deepEqual(events.filter((event) => event.type === "result"), [{ type: "result", text: "ok" }]);
});

test("cumulative streaming snapshots do not consume retained history", () => {
  let run: SubagentRun = { status: "running", startedAt: 0, lastActivityAt: 0, items: [] };
  for (let i = 0; i < 5; i++) run = reduceSubagentEvent(run, { type: "tool_start", id: `t_${i}`, name: "read" });

  // Stream many cumulative snapshots for a single in-flight block.
  for (let i = 0; i < 50; i++) run = reduceSubagentEvent(run, { type: "thinking", text: `snapshot ${i}`, contentIndex: 7 });

  const kinds = run.items.map((item) => item.kind);
  assert.equal(kinds.filter((kind) => kind === "thinking").length, 1);
  assert.equal(kinds.filter((kind) => kind === "tool").length, 5);
});

