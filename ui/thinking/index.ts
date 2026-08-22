import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Static label shown instead of thinking content when thinking blocks are hidden. */
export const HIDDEN_THINKING_LABEL = "+ Thought";

/** Rewrites assistant thinking blocks: strips a leading "thinking:" prefix and normalizes the ✦ bullet. */
export function formatThinking(markdown: string): string {
  const text = markdown.replace(/^\s*(?:thinking\s*:\s*)+/i, "").trim();
  if (!text) return text;
  return text.split(/\n{2,}/).map((block) => {
    const value = block.replace(/^\s*(?:✦\s*)+/, "").trim();
    return value ? `✦ ${value}` : "";
  }).join("\n\n");
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
