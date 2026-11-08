import type { ExtensionAPI, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import type { UnresolvedBackgroundRun } from "./background.ts";

export function formatUnresolvedRuns(runs: readonly UnresolvedBackgroundRun[]): string {
  return [
    "Background subagents are unresolved:",
    ...runs.map((run) => `- ${run.runId} ${run.profile} status=${run.status} revision=${run.revision}`),
  ].join("\n");
}

export function setupSubagentSettleGuard(
  pi: ExtensionAPI,
  listUnresolved: () => UnresolvedBackgroundRun[],
): void {
  let guardedTurn: number | undefined;

  pi.on("session_start", () => { guardedTurn = undefined; });
  pi.on("turn_end", (event: TurnEndEvent) => {
    const unresolved = listUnresolved();
    if (unresolved.length === 0 || event.toolResults.length > 0) {
      guardedTurn = undefined;
      return;
    }
    if (guardedTurn === event.turnIndex) return;

    guardedTurn = event.turnIndex;
    pi.sendMessage({
      customType: "subagent-settle-guard",
      content: formatUnresolvedRuns(unresolved),
      display: false,
    }, { triggerTurn: true, deliverAs: "followUp" });
  });
}