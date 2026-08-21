import type { SubagentEvent } from "./events.ts";
import type { SubagentRun } from "./types.ts";
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

function parseToolArguments(raw: unknown): Record<string, unknown> | undefined {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {}
  }
  return undefined;
}

function decodeMessageEnd(event: Record<string, unknown>): SubagentEvent[] {
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.role === "tool" && typeof message.toolCallId === "string") {
    const isError = message.isError === true;
    return [{ type: "tool_end", id: message.toolCallId, isError, result: textContent(message.content) }];
  }
  if (message?.role !== "assistant") return [];

  const usageEvents: SubagentEvent[] = [];
  const rawUsage = (typeof message.usage === "object" && message.usage !== null)
    ? message.usage
    : (typeof event.usage === "object" && event.usage !== null)
      ? event.usage
      : undefined;
  if (rawUsage && typeof rawUsage === "object") {
    usageEvents.push({ type: "usage", usage: rawUsage as NonNullable<SubagentRun["usage"]> });
  }

  if (typeof message.content === "string" && message.content.trim()) {
    return [
      { type: "result" as const, text: truncateRetainedText(message.content) },
      ...usageEvents,
    ];
  }

  if (!Array.isArray(message.content)) {
    return usageEvents;
  }

  const events = message.content.flatMap((part, contentIndex): SubagentEvent[] => {
    if (typeof part !== "object" || part === null) return [];

    const value = part as Record<string, unknown>;
    if (value.type === "thinking" && typeof value.text === "string") return [{ type: "thinking", text: value.text, contentIndex }];
    if (value.type === "text" && typeof value.text === "string") return [{ type: "result", text: value.text }];
    if (value.type === "toolCall" && typeof value.id === "string" && typeof value.name === "string") {
      const args = parseToolArguments(value.arguments ?? value.args);
      return [{
        type: "tool_start",
        id: value.id,
        name: value.name,
        ...(args !== undefined ? { args } : {}),
      }];
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
    ...usageEvents,
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

export type InFlightBlock =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "toolcall"; id: string; name: string; rawArgs: string };

function decodeAssistantMessageEvent(
  ame: Record<string, unknown>,
  inFlightBlocks?: Map<number, InFlightBlock>,
): SubagentEvent[] {
  const contentIndex = typeof ame.contentIndex === "number" ? ame.contentIndex : 0;
  const ameType = typeof ame.type === "string" ? ame.type : "";

  switch (ameType) {
    case "thinking_start": {
      inFlightBlocks?.set(contentIndex, { type: "thinking", text: "" });
      return [];
    }
    case "thinking_delta": {
      // Pi streams cumulative thinking snapshots; set (not append) the block text.
      const delta = typeof ame.delta === "string" ? ame.delta : "";
      let block = inFlightBlocks?.get(contentIndex);
      if (!block || block.type !== "thinking") {
        block = { type: "thinking", text: "" };
        inFlightBlocks?.set(contentIndex, block);
      }
      block.text = delta;
      return [{ type: "thinking", text: block.text, contentIndex }];
    }
    case "thinking_end": {
      let block = inFlightBlocks?.get(contentIndex);
      if (typeof ame.content === "string") {
        if (!block || block.type !== "thinking") {
          block = { type: "thinking", text: "" };
          inFlightBlocks?.set(contentIndex, block);
        }
        block.text = ame.content;
      }
      const text = block?.type === "thinking" ? block.text : (typeof ame.content === "string" ? ame.content : "");
      inFlightBlocks?.delete(contentIndex);
      return [{ type: "thinking", text, contentIndex }];
    }
    case "text_start": {
      inFlightBlocks?.set(contentIndex, { type: "text", text: "" });
      return [];
    }
    case "text_delta": {
      const delta = typeof ame.delta === "string" ? ame.delta : "";
      let block = inFlightBlocks?.get(contentIndex);
      if (!block || block.type !== "text") {
        block = { type: "text", text: "" };
        inFlightBlocks?.set(contentIndex, block);
      }
      block.text += delta;
      return [{ type: "result", text: block.text }];
    }
    case "text_end": {
      let block = inFlightBlocks?.get(contentIndex);
      if (typeof ame.content === "string") {
        if (!block || block.type !== "text") {
          block = { type: "text", text: "" };
          inFlightBlocks?.set(contentIndex, block);
        }
        block.text = ame.content;
      }
      const text = block?.type === "text" ? block.text : (typeof ame.content === "string" ? ame.content : "");
      inFlightBlocks?.delete(contentIndex);
      return [{ type: "result", text }];
    }
    case "toolcall_start": {
      const id = typeof ame.id === "string" ? ame.id : "";
      const name = typeof ame.name === "string" ? ame.name : "tool";
      inFlightBlocks?.set(contentIndex, { type: "toolcall", id, name, rawArgs: "" });
      if (id) {
        return [{ type: "tool_start", id, name }];
      }
      return [];
    }
    case "toolcall_delta": {
      const delta = typeof ame.delta === "string" ? ame.delta : "";
      let block = inFlightBlocks?.get(contentIndex);
      if (!block || block.type !== "toolcall") {
        block = { type: "toolcall", id: "", name: "tool", rawArgs: "" };
        inFlightBlocks?.set(contentIndex, block);
      }
      block.rawArgs += delta;
      const args = parseToolArguments(block.rawArgs);
      if (block.id) {
        return [{
          type: "tool_start",
          id: block.id,
          name: block.name || "tool",
          ...(args !== undefined ? { args } : {}),
        }];
      }
      return [];
    }
    case "toolcall_end": {
      const block = inFlightBlocks?.get(contentIndex);
      const toolCall = ame.toolCall as Record<string, unknown> | undefined;
      const id = typeof toolCall?.id === "string"
        ? toolCall.id
        : (block?.type === "toolcall" && block.id ? block.id : "");
      const name = typeof toolCall?.name === "string"
        ? toolCall.name
        : (block?.type === "toolcall" && block.name ? block.name : "tool");
      const rawArgs = toolCall?.arguments ?? toolCall?.args ?? (block?.type === "toolcall" ? block.rawArgs : undefined);
      const args = parseToolArguments(rawArgs);
      inFlightBlocks?.delete(contentIndex);
      if (id) {
        return [{
          type: "tool_start",
          id,
          name,
          ...(args !== undefined ? { args } : {}),
        }];
      }
      return [];
    }
    default:
      return [];
  }
}

export function decodePiEvent(
  value: unknown,
  inFlightBlocks?: Map<number, InFlightBlock>,
): SubagentEvent[] {
  if (typeof value !== "object" || value === null) {
    return [{ type: "diagnostic", message: "Pi JSON event must be an object" }];
  }

  const event = value as Record<string, unknown>;

  if (event.type === "message_start") {
    inFlightBlocks?.clear();
    return [];
  }

  if (event.type === "message_update") {
    const ame = event.assistantMessageEvent as Record<string, unknown> | undefined;
    if (ame && typeof ame.type === "string") {
      return decodeAssistantMessageEvent(ame, inFlightBlocks);
    }
    const message = event.message as Record<string, unknown> | undefined;
    if (message?.role === "assistant" || message?.role === "tool") return decodeMessageEnd(event);
    return [];
  }

  if (event.type === "message_end") {
    inFlightBlocks?.clear();
    return decodeMessageEnd(event);
  }

  if (event.type === "turn_end") {
    inFlightBlocks?.clear();
    const message = event.message as Record<string, unknown> | undefined;
    if (message?.role === "assistant" || message?.role === "tool") {
      return decodeMessageEnd(event);
    }
    const rawUsage = (typeof message?.usage === "object" && message.usage !== null)
      ? message.usage
      : (typeof event.usage === "object" && event.usage !== null)
        ? event.usage
        : undefined;
    if (rawUsage && typeof rawUsage === "object") {
      return [{ type: "usage", usage: rawUsage as NonNullable<SubagentRun["usage"]> }];
    }
    return [];
  }

  if (event.type === "agent_end") {
    inFlightBlocks?.clear();
    if (Array.isArray(event.messages)) {
      const events: SubagentEvent[] = [];
      for (const msg of event.messages) {
        if (typeof msg === "object" && msg !== null) {
          if (msg.role === "tool" && typeof msg.toolCallId === "string") {
            events.push({
              type: "tool_end",
              id: msg.toolCallId,
              isError: msg.isError === true,
              result: textContent(msg.content),
            });
          }
        }
      }
      const lastAssistant = [...event.messages]
        .reverse()
        .find((m): m is Record<string, unknown> => typeof m === "object" && m !== null && m.role === "assistant");
      if (lastAssistant) {
        events.push(...decodeMessageEnd({ type: "message_end", message: lastAssistant }));
      }
      return events;
    }
    return [];
  }

  if (event.type === "tool_execution_start" && typeof event.toolCallId === "string") {
    const args = parseToolArguments(event.args ?? event.arguments);
    return [{
      type: "tool_start",
      id: event.toolCallId,
      name: typeof event.toolName === "string" ? event.toolName : "tool",
      ...(args !== undefined ? { args } : {}),
    }];
  }

  if (event.type === "tool_execution_end" || event.type === "tool_result_end") {
    return decodeToolEnd(event);
  }

  return [{ type: "diagnostic", message: `Unknown Pi event: ${typeof event.type === "string" ? event.type : "missing type"}` }];
}

export class PiJsonDecoder {
  private buffer = "";
  private inFlightBlocks = new Map<number, InFlightBlock>();

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

    return lines.flatMap((line) => this.decodeLine(line));
  }

  private decodeLine(line: string): SubagentEvent[] {
    if (!line.trim()) return [];

    try {
      return decodePiEvent(JSON.parse(line), this.inFlightBlocks);
    } catch {
      return [{ type: "diagnostic", message: `Malformed Pi JSON: ${line.slice(0, 200)}` }];
    }
  }
}
