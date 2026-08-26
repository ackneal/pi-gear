import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { ActiveBackgroundRun } from "./background.ts";

export function formatActiveRuns(runs: readonly ActiveBackgroundRun[]): string {
  return [
    "Background subagents are still active:",
    ...runs.map((run) => `- ${run.runId} ${run.profile} revision=${run.revision}`),
  ].join("\n");
}

export function setupSubagentSettleGuard(
  pi: ExtensionAPI,
  listActive: () => ActiveBackgroundRun[],
): void {
  let guardedTurn: number | undefined;

  pi.on("session_start", () => { guardedTurn = undefined; });
  pi.on("turn_end", (event: TurnEndEvent) => {
    const active = listActive();
    if (active.length === 0 || event.toolResults.length > 0) {
      guardedTurn = undefined;
      return;
    }
    if (guardedTurn === event.turnIndex) return;

    guardedTurn = event.turnIndex;
    pi.sendMessage({
      customType: "subagent-settle-guard",
      content: formatActiveRuns(active),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  });
}
