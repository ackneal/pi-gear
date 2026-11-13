import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Static label shown instead of thinking content when thinking blocks are hidden. */
export const HIDDEN_THINKING_LABEL = "✦ Thought";

/** Remove an explicit leading label without changing the Markdown body. */
export function formatThinking(markdown: string): string {
  return markdown.replace(/^\s*(?:thinking[\t ]*:[\t ]*)+/i, "");
}

export function setupThinkingDisplay(pi: ExtensionAPI): void {
  pi.registerMarkdownTransformer((markdown, { messageType }) => {
    if (messageType !== "assistant-thinking") return markdown;
    return formatThinking(markdown);
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setHiddenThinkingLabel(HIDDEN_THINKING_LABEL);
  });
}
