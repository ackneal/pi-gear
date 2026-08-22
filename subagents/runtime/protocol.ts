import type { SubagentEvent } from "./events.ts";
import type { SubagentRun } from "./types.ts";
import { MAX_DECODER_BUFFER_CHARS, truncateRetainedText } from "./limits.ts";

const textContent = (content: unknown): string => truncateRetainedText(
  Array.isArray(content)
    ? content.flatMap((part) => {
        if (typeof part !== "object" || part === null) return [];
        const value = part as Record<string, unknown>;
        if (value.type === "text" && typeof value.text === "string") return [value.text];
        if (value.type === "thinking" && typeof value.thinking === "string") return [value.thinking];
        return [];
      }).join("")
    : typeof content === "string" ? content : "",
);

function argumentsObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

type InFlightBlock = { type: "thinking" | "text"; text: string };

function liveDelta(event: Record<string, unknown>, blocks: Map<number, InFlightBlock>, messageId: number): SubagentEvent[] {
  const update = event.assistantMessageEvent as Record<string, unknown> | undefined;
  if (!update || typeof update.type !== "string") return [];
  const index = typeof update.contentIndex === "number" ? update.contentIndex : 0;
  if (update.type === "thinking_start") { blocks.set(index, { type: "thinking", text: "" }); return []; }
  if (update.type === "text_start") { blocks.set(index, { type: "text", text: "" }); return []; }
  if (update.type !== "thinking_delta" && update.type !== "text_delta") return [];
  const kind = update.type === "thinking_delta" ? "thinking" : "text";
  let block = blocks.get(index);
  if (!block || block.type !== kind) blocks.set(index, block = { type: kind, text: "" });
  block.text += typeof update.delta === "string" ? update.delta : "";
  return kind === "thinking"
    ? [{ type: "thinking", text: truncateRetainedText(block.text), contentIndex: index, ...(messageId > 1 ? { messageId } : {}) }]
    : [{ type: "result", text: truncateRetainedText(block.text) }];
}

function assistantEnd(event: Record<string, unknown>, messageId: number): SubagentEvent[] {
  const message = event.message as Record<string, unknown> | undefined;
  if (message?.role !== "assistant") return [];
  const output: SubagentEvent[] = [];
  let text = "";
  if (Array.isArray(message.content)) message.content.forEach((part, contentIndex) => {
    if (typeof part !== "object" || part === null) return;
    const value = part as Record<string, unknown>;
    if (value.type === "thinking" && typeof value.thinking === "string") {
      output.push({ type: "thinking", text: value.thinking, contentIndex, ...(messageId > 1 ? { messageId } : {}) });
    } else if (value.type === "text" && typeof value.text === "string") text += value.text;
  });
  if (text) output.push({ type: "result", text: truncateRetainedText(text) });
  if (typeof message.usage === "object" && message.usage !== null) {
    output.push({ type: "usage", usage: message.usage as NonNullable<SubagentRun["usage"]> });
  }
  return output;
}

export function decodePiEvent(value: unknown, blocks = new Map<number, InFlightBlock>(), messageId = 1): SubagentEvent[] {
  if (typeof value !== "object" || value === null) return [{ type: "diagnostic", message: "Pi JSON event must be an object" }];
  const event = value as Record<string, unknown>;
  if (event.type === "message_start") { blocks.clear(); return []; }
  if (event.type === "message_update") return liveDelta(event, blocks, messageId);
  if (event.type === "message_end") { blocks.clear(); return assistantEnd(event, messageId); }
  if (event.type === "tool_execution_start" && typeof event.toolCallId === "string" && typeof event.toolName === "string") {
    const args = argumentsObject(event.args);
    return [{ type: "tool_start", id: event.toolCallId, name: event.toolName, ...(args ? { args } : {}) }];
  }
  if (event.type === "tool_execution_end" && typeof event.toolCallId === "string") {
    const result = event.result as Record<string, unknown> | undefined;
    return [{ type: "tool_end", id: event.toolCallId, isError: event.isError === true, result: textContent(result?.content) }];
  }
  if (event.type === "turn_end" || event.type === "agent_end") { blocks.clear(); return []; }
  return [{ type: "diagnostic", message: `Unknown Pi event: ${typeof event.type === "string" ? event.type : "missing type"}` }];
}

export class PiJsonDecoder {
  private buffer = "";
  private blocks = new Map<number, InFlightBlock>();
  private messageId = 0;

  push(chunk: Buffer | string, final = false): SubagentEvent[] {
    this.buffer += chunk.toString();
    if (this.buffer.length > MAX_DECODER_BUFFER_CHARS && !this.buffer.includes("\n")) {
      this.buffer = "";
      return [{ type: "diagnostic", message: "Pi JSON line exceeded decoder limit and was discarded" }];
    }
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    if (final && this.buffer.trim()) { lines.push(this.buffer); this.buffer = ""; }
    return lines.flatMap((line) => this.decodeLine(line));
  }

  private decodeLine(line: string): SubagentEvent[] {
    if (!line.trim()) return [];
    if (line.length > MAX_DECODER_BUFFER_CHARS) return [{ type: "diagnostic", message: "Pi JSON line exceeded decoder limit and was discarded" }];
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (value.type === "message_start") this.messageId++;
      return decodePiEvent(value, this.blocks, Math.max(1, this.messageId));
    } catch {
      return [{ type: "diagnostic", message: `Malformed Pi JSON: ${line.slice(0, 200)}` }];
    }
  }
}
