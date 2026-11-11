import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { TaskItem, TaskRecord } from "./task-types.ts";

const MAX_ITEMS = 100;
const MAX_TEXT = 16_384;

/** Owns bounded task history, not the SDK's live message objects. */
export class TaskEventRecorder {
  private messageId = 0;

  private readonly task: TaskRecord;

  constructor(task: TaskRecord) {
    this.task = task;
  }

  private text(value: string): string {
    if (value.length <= MAX_TEXT) return value;
    this.task.itemsTruncated = true;
    return value.slice(0, MAX_TEXT);
  }

  private serialize(value: unknown): string {
    try {
      return JSON.stringify(value) ?? "null";
    } catch {
      this.task.itemsTruncated = true;
      return JSON.stringify({ error: "Unserializable tool event payload" });
    }
  }

  private append(item: TaskItem): void {
    this.task.items.push(item);
    if (this.task.items.length > MAX_ITEMS) {
      this.task.items.shift();
      this.task.itemsTruncated = true;
    }
  }

  private thinking(contentIndex: number, text: string, append: boolean): void {
    const item = this.task.items.find((item) =>
      item.kind === "thinking" && item.messageId === this.messageId && item.contentIndex === contentIndex,
    );
    if (item?.kind === "thinking") {
      item.text = this.text(append ? item.text + text : text);
    } else {
      this.append({ kind: "thinking", messageId: this.messageId, contentIndex, text: this.text(text) });
    }
  }

  record(event: AgentSessionEvent): void {
    if (event.type === "message_start" && event.message.role === "assistant") {
      this.messageId++;
    }

    if (event.type === "message_update") {
      const stream = event.assistantMessageEvent;
      if (stream.type === "thinking_start") this.thinking(stream.contentIndex, "", false);
      if (stream.type === "thinking_delta") this.thinking(stream.contentIndex, stream.delta, true);
      if (stream.type === "thinking_end") this.thinking(stream.contentIndex, stream.content, false);
    }

    if (event.type === "message_end" && event.message.role === "assistant") {
      event.message.content.forEach((content, index) => {
        if (content.type === "thinking") this.thinking(index, content.thinking, false);
      });
      const text = event.message.content.filter((content) => content.type === "text").map((content) => content.text).join("\n");
      if (text) this.append({ kind: "message", role: "assistant", text: this.text(text) });
    }

    if (event.type !== "tool_execution_start" && event.type !== "tool_execution_update" && event.type !== "tool_execution_end") return;

    let item = this.task.items.find((item) => item.kind === "tool" && item.id === event.toolCallId);
    if (item?.kind !== "tool") {
      item = { kind: "tool", id: event.toolCallId, name: event.toolName, status: "running" };
      this.append(item);
    }

    if (event.type !== "tool_execution_end") {
      const args = this.serialize(event.args ?? {});
      item.args = args.length > MAX_TEXT
        ? { truncated: this.text(args) }
        : JSON.parse(args);
    }
    if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
      const result = event.type === "tool_execution_end" ? event.result : event.partialResult;
      item.result = this.text(this.serialize(result));
    }
    if (event.type === "tool_execution_end") item.status = event.isError ? "error" : "success";
  }
}
