import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { UnresolvedBackgroundRun } from "./background.ts";
import { setupSubagentSettleGuard } from "./settle-guard.ts";

function turn(turnIndex: number, toolResults: unknown[] = []): TurnEndEvent {
  return { type: "turn_end", turnIndex, message: { role: "assistant", content: [] } as never, toolResults: toolResults as never };
}

function harness(unresolved: UnresolvedBackgroundRun[]) {
  let onTurnEnd!: (event: TurnEndEvent) => void;
  let onSessionStart!: () => void;
  const messages: Array<{ message: { content: string; display: boolean; customType: string }; options: unknown }> = [];
  const pi = {
    on: (event: string, handler: unknown) => {
      if (event === "turn_end") onTurnEnd = handler as typeof onTurnEnd;
      if (event === "session_start") onSessionStart = handler as typeof onSessionStart;
    },
    sendMessage: (message: { content: string; display: boolean; customType: string }, options: unknown) => {
      messages.push({ message, options });
      return new Promise(() => {});
    },
  } as unknown as ExtensionAPI;
  setupSubagentSettleGuard(pi, () => unresolved);
  return { messages, onTurnEnd, onSessionStart, setUnresolved: (runs: UnresolvedBackgroundRun[]) => { unresolved = runs; } };
}

const running: UnresolvedBackgroundRun = { runId: "run-a", status: "running", revision: 3, profile: "worker" };
const cancelling: UnresolvedBackgroundRun = { runId: "run-b", status: "cancelling", revision: 5, profile: "researcher" };

test("natural completion with unresolved runs queues one compact non-blocking continuation", () => {
  const subject = harness([running, cancelling]);
  const returned = subject.onTurnEnd(turn(7));

  assert.equal(returned, undefined);
  assert.equal(subject.messages.length, 1);
  assert.deepEqual(subject.messages[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(subject.messages[0]?.message.display, false);
  assert.equal(subject.messages[0]?.message.content, "Background subagents are unresolved:\n- run-a worker status=running revision=3\n- run-b researcher status=cancelling revision=5");

  subject.onTurnEnd(turn(7));
  assert.equal(subject.messages.length, 1);
});

test("guard skips resolved state and ordinary tool-producing turns", () => {
  const subject = harness([]);
  subject.onTurnEnd(turn(1));
  assert.equal(subject.messages.length, 0);

  subject.setUnresolved([running]);
  subject.onTurnEnd(turn(2, [{}]));
  assert.equal(subject.messages.length, 0);
});

test("unresolved terminal result still triggers the guard until observed", () => {
  const subject = harness([{ runId: "run-x", profile: "worker", status: "success", revision: 9 }]);
  subject.onTurnEnd(turn(1));
  assert.equal(subject.messages.length, 1);
  assert.match(subject.messages[0]?.message.content ?? "", /run-x worker status=success revision=9/);

  subject.setUnresolved([]);
  subject.onTurnEnd(turn(2));
  assert.equal(subject.messages.length, 1);
});

test("later settle attempts can continue while duplicate lifecycle delivery cannot loop", () => {
  const subject = harness([running]);
  subject.onTurnEnd(turn(1));
  subject.onTurnEnd(turn(1));
  assert.equal(subject.messages.length, 1);

  subject.onTurnEnd(turn(2));
  assert.equal(subject.messages.length, 2);

  subject.onSessionStart();
  subject.onTurnEnd(turn(2));
  assert.equal(subject.messages.length, 3);
});