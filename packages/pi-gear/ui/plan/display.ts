import * as PiTui from "@earendil-works/pi-tui";

const tui = PiTui as unknown as {
  stripTerminalSequences(text: string): string;
  truncateToWidth(text: string, maxWidth: number, ellipsis?: string): string;
  visibleWidth(text: string): number;
  wrapTextWithAnsi(text: string, width: number): string[];
};

export const { truncateToWidth, visibleWidth, wrapTextWithAnsi } = tui;

export function sanitizeDisplayText(value: string): string {
  return tui.stripTerminalSequences(value)
    .replace(/[\r\n\t]/g, " ")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function wrapDisplayText(value: string, prefix: string, continuation: string, width: number): string[] {
  const prefixWidth = Math.max(visibleWidth(prefix), visibleWidth(continuation));
  if (width <= prefixWidth) return [truncateToWidth(`${prefix}${sanitizeDisplayText(value)}`, width, "…")];
  const available = width - prefixWidth;
  return wrapTextWithAnsi(sanitizeDisplayText(value), available).map((line, index) => `${index === 0 ? prefix : continuation}${line}`);
}
