import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { setupLoopGuard } from "./loop.ts";

test("loop guard nudges once at each threshold and resets per agent run", async () => {
  let turnEnd: (() => Promise<void>) | undefined;
  let agentStart: (() => void) | undefined;
  const messages: Array<{ content: string; display: boolean; options: unknown }> = [];
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "turn_end") turnEnd = listener as typeof turnEnd;
      if (event === "agent_start") agentStart = listener as typeof agentStart;
    },
    sendMessage: async (message: { content: string; display: boolean }, options: unknown) => {
      messages.push({ ...message, options });
    },
  } as unknown as ExtensionAPI;
  setupLoopGuard(pi);
  assert.ok(turnEnd);
  assert.ok(agentStart);

  for (let turn = 0; turn < 25; turn += 1) await turnEnd();
  assert.equal(messages.length, 2);
  assert.deepEqual(messages.map(({ options }) => options), [{ deliverAs: "steer" }, { deliverAs: "steer" }]);
  assert.equal(messages.every(({ display }) => display === false), true);
  assert.match(messages[0]!.content, /concrete progress/i);
  assert.match(messages[1]!.content, /Reassess the approach and scope/);
  assert.equal(messages.every(({ content }) => !/\bstop\b|wait for direction/i.test(content)), true);

  await turnEnd();
  assert.equal(messages.length, 2);
  agentStart();
  for (let turn = 0; turn < 15; turn += 1) await turnEnd();
  assert.equal(messages.length, 3);
});
