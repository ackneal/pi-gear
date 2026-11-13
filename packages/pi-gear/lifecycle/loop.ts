import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Loop guard: soft nudge first, firmer advisory nudge as a backstop. */
const SOFT_TURN_LIMIT = 15;
const HARD_TURN_LIMIT = 25;

export function setupLoopGuard(pi: ExtensionAPI): void {
  let turns = 0;
  let softWarned = false;
  let hardWarned = false;

  const reset = (): void => {
    turns = 0;
    softWarned = false;
    hardWarned = false;
  };

  pi.on("turn_end", async () => {
    turns += 1;

    // Second, firmer nudge at 25 turns. Still advisory: sendMessage stays out
    // of the conversation and never impersonates the user.
    if (turns >= HARD_TURN_LIMIT && !hardWarned) {
      hardWarned = true;
      await pi.sendMessage({
        customType: "loop-guard",
        content: "You've now run 25 consecutive turns. Reassess the approach and scope: continue if there is clear recent progress. " +
          "If repeated attempts are not advancing, or a user decision is required, summarize the relevant evidence and ask one focused question.",
        display: false,
      }, { deliverAs: "steer" });
      return;
    }

    // First, gentle nudge at 15 turns: advisory, no forced interruption.
    if (turns >= SOFT_TURN_LIMIT && !softWarned) {
      softWarned = true;
      await pi.sendMessage({
        customType: "loop-guard",
        content: "Assess whether recent turns show concrete progress; continue if they do. " +
          "Ask one focused user question only if missing user information blocks progress.",
        display: false,
      }, { deliverAs: "steer" });
    }
  });

  pi.on("agent_start", reset);
  pi.on("agent_settled", reset);
}
