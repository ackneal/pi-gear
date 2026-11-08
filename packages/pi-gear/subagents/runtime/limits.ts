export const MAX_DECODER_BUFFER_CHARS = 64_000;
export const MAX_RETAINED_TEXT_CHARS = 16_000;
export const MAX_RETAINED_ITEMS = 200;
export const MAX_STDERR_CHARS = 16_000;
export const TRUNCATION_MARKER = "\n[truncated]";

export function truncateRetainedText(text: string, limit = MAX_RETAINED_TEXT_CHARS): string {
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - TRUNCATION_MARKER.length))}${TRUNCATION_MARKER}` : text;
}
