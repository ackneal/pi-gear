export type SubagentEvent =
  | { type: "thinking"; text: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; isError: boolean; result: string }
  | { type: "result"; text: string }
  | { type: "diagnostic"; message: string };
