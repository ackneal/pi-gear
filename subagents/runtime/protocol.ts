import type { SubagentEvent } from "./events.ts";
import { MAX_DECODER_BUFFER_CHARS, truncateRetainedText } from "./limits.ts";

const textContent = (content: unknown): string => truncateRetainedText(
  Array.isArray(content)
    ? content
        .filter((part): part is Record<string, unknown> => typeof part === "object" && part !== null)
        .filter((part) => part.type === "text" || part.type === "thinking")
        .map((part) => typeof part.text === "string" ? part.text : "")
        .join("")
    : typeof content === "string" ? content : "",
);

function decodeMessageEnd(event: Record<string, unknown>): SubagentEvent[] {
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.role !== "assistant" || !Array.isArray(message.content)) return [];

  const events = message.content.flatMap((part): SubagentEvent[] => {
    if (typeof part !== "object" || part === null) return [];

    const value = part as Record<string, unknown>;
    if (value.type === "thinking" && typeof value.text === "string") return [{ type: "thinking", text: value.text }];
    if (value.type === "text" && typeof value.text === "string") return [{ type: "result", text: value.text }];
    if (value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string") {
      return [{ type: "tool_start", id: value.id, name: value.name }];
    }
    return [];
  });
  const text = events
    .filter((item): item is Extract<SubagentEvent, { type: "result" }> => item.type === "result")
    .map((item) => item.text)
    .join("");

  return [
    ...events.filter((item) => item.type !== "result"),
    ...(text ? [{ type: "result" as const, text: truncateRetainedText(text) }] : []),
  ];
}

function decodeToolEnd(event: Record<string, unknown>): SubagentEvent[] {
  const message = event.message as Record<string, unknown> | undefined;
  const id = typeof event.toolCallId === "string"
    ? event.toolCallId
    : typeof message?.toolCallId === "string" ? message.toolCallId : "";
  if (!id) return [];

  const isError = typeof event.isError === "boolean" ? event.isError : message?.isError === true;
  const content = (event.result as Record<string, unknown> | undefined)?.content ?? message?.content;
  return [{ type: "tool_end", id, isError, result: textContent(content) }];
}

export function decodePiEvent(value: unknown): SubagentEvent[] {
  if (typeof value !== "object" || value === null) {
    return [{ type: "diagnostic", message: "Pi JSON event must be an object" }];
  }

  const event = value as Record<string, unknown>;
  if (event.type === "message_end") return decodeMessageEnd(event);
  if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
    return [{
      type: "tool_start",
      id: event.toolCallId,
      name: typeof event.toolName === "string" ? event.toolName : "tool",
    }];
  }
  if (event.type === "tool_execution_end" || event.type === "tool_result_end") {
    return decodeToolEnd(event);
  }

  return [{ type: "diagnostic", message: `Unknown Pi event: ${typeof event.type === "string" ? event.type : "missing type"}` }];
}

function decodeLine(line: string): SubagentEvent[] {
  if (!line.trim()) return [];

  try {
    return decodePiEvent(JSON.parse(line));
  } catch {
    return [{ type: "diagnostic", message: `Malformed Pi JSON: ${line.slice(0, 200)}` }];
  }
}

export class PiJsonDecoder {
  private buffer = "";

  push(chunk: Buffer | string, final = false): SubagentEvent[] {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_DECODER_BUFFER_CHARS && !this.buffer.includes("\n")) {
      this.buffer = "";
      return [{ type: "diagnostic", message: "Pi JSON line exceeded decoder limit and was discarded" }];
    }

    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    if (final && this.buffer.trim()) {
      lines.push(this.buffer);
      this.buffer = "";
    }

    return lines.flatMap(decodeLine);
  }
}
