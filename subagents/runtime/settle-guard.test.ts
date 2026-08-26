import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { ActiveBackgroundRun } from "./background.ts";
import { setupSubagentSettleGuard } from "./settle-guard.ts";

function turn(turnIndex: number, toolResults: unknown[] = []): TurnEndEvent {
  return { type: "turn_end", turnIndex, message: { role: "assistant", content: [] } as never, toolResults: toolResults as never };
}

function harness(active: ActiveBackgroundRun[]) {
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
  setupSubagentSettleGuard(pi, () => active);
  return { messages, onTurnEnd, onSessionStart, setActive: (runs: ActiveBackgroundRun[]) => { active = runs; } };
}

const running: ActiveBackgroundRun = { runId: "run-a", status: "running", revision: 3, profile: "worker" };
const cancelling: ActiveBackgroundRun = { runId: "run-b", status: "cancelling", revision: 5, profile: "researcher" };

test("natural completion with active runs queues one compact non-blocking continuation", () => {
  const subject = harness([running, cancelling]);
  const returned = subject.onTurnEnd(turn(7));

  assert.equal(returned, undefined);
  assert.equal(subject.messages.length, 1);
  assert.deepEqual(subject.messages[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(subject.messages[0]?.message.display, false);
  assert.equal(subject.messages[0]?.message.content, "Background subagents are still active:\n- run-a worker revision=3\n- run-b researcher revision=5");

  subject.onTurnEnd(turn(7));
  assert.equal(subject.messages.length, 1);
});

test("guard skips terminal state and ordinary tool-producing turns", () => {
  const subject = harness([]);
  subject.onTurnEnd(turn(1));
  assert.equal(subject.messages.length, 0);

  subject.setActive([running]);
  subject.onTurnEnd(turn(2, [{}]));
  assert.equal(subject.messages.length, 0);
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
