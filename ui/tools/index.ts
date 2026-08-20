import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getLanguageFromPath,
  highlightCode,
  renderDiff,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import * as PiTui from "@earendil-works/pi-tui";

const { truncateToWidth, wrapTextWithAnsi } = PiTui as unknown as {
  truncateToWidth(text: string, maxWidth: number, ellipsis?: string): string;
  wrapTextWithAnsi(text: string, width: number): string[];
};

type AnyDefinition = ToolDefinition<any, any, any>;
type AnyContext = {
  args: unknown;
  cwd: string;
  expanded: boolean;
  isError: boolean;
  lastComponent: unknown;
  state: unknown;
  executionStarted: boolean;
  invalidate: () => void;
  argsComplete: boolean;
  isPartial: boolean;
  showImages: boolean;
  toolCallId: string;
};
type AnyResult = AgentToolResult<any>;

type TextMode = "compact" | "detail";
type TextBlock = { value: string; mode: TextMode };

class CompactText {
  private blocks: TextBlock[];
  constructor(value: string, mode: TextMode = "compact") { this.blocks = [{ value, mode }]; }
  static headerAndDetail(header: string, detail: string): CompactText {
    const component = new CompactText("");
    component.blocks = [{ value: header, mode: "compact" }, { value: detail, mode: "detail" }];
    return component;
  }
  render(width: number): string[] {
    const lineWidth = Math.max(1, width);
    return this.blocks.flatMap(({ value, mode }) => !value.trim() ? [] : value.split("\n").flatMap((line) => mode === "compact" ? [truncateToWidth(line, lineWidth, "…")] : wrapTextWithAnsi(line, lineWidth)));
  }
  invalidate(): void {}
}

function empty(): CompactText { return new CompactText(""); }

function clean(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\r\n]+/g, " ")
    : "";
}

function displayPath(value: unknown, cwd: string): string {
  const raw = clean(value);
  if (!raw) return "<path>";
  const absolute = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const displayed = relative(cwd, absolute) || ".";
  return displayed.split(sep).join("/");
}

function readRange(args: Record<string, unknown>): string {
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  if (offset === undefined && limit === undefined) return "";
  const start = offset ?? 1;
  return limit === undefined ? `:${start}` : `:${start}-${start + limit - 1}`;
}

function headerText(marker: "+" | "-", label: string, target: string, theme: Theme): string {
  return `${theme.fg("muted", marker)} ${theme.fg("toolTitle", theme.bold(label.padEnd(7)))}${theme.fg("text", target)}`;
}

function header(marker: "+" | "-", label: string, target: string, theme: Theme): CompactText {
  return new CompactText(headerText(marker, label, target, theme));
}

function parseArgsObject(rawArgs: unknown): Record<string, unknown> {
  if (rawArgs && typeof rawArgs === "object") return rawArgs as Record<string, unknown>;
  if (typeof rawArgs === "string") {
    try {
      const parsed = JSON.parse(rawArgs);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return {};
}

function fileCall(label: string) {
  return (rawArgs: unknown, theme: Theme, context: AnyContext) => {
    const args = parseArgsObject(rawArgs ?? context?.args);
    const suffix = label === "READ" ? readRange(args) : "";
    return header(context.expanded ? "-" : "+", label, ` ${displayPath(args.file_path ?? args.path ?? args.filepath, context.cwd)}${suffix}`, theme);
  };
}

function textResult(result: AnyResult): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

function fileResult(kind: "read" | "edit" | "write", base: AnyDefinition) {
  return (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
    if (kind === "read" && base.renderResult) {
      return base.renderResult(result, options, theme, context as never);
    }

    const text = textResult(result);
    if (kind === "edit") {
      if (context.isError) return new CompactText(theme.fg("error", text), "detail");
      if (!options.expanded || typeof result.details?.diff !== "string") return empty();
      return new CompactText(renderDiff(result.details.diff, { filePath: displayPath((context.args as Record<string, unknown>).path, context.cwd) }), "detail");
    }

    return context.isError && text
      ? new CompactText(theme.fg("error", text), "detail")
      : empty();
  };
}

function formatWriteContent(args: Record<string, unknown>, theme: Theme, context: AnyContext): string {
  if (typeof args.content !== "string" || !args.content) return "";
  const content = args.content.replace(/\r\n?/g, "\n").replace(/\t/g, "  ");
  const language = getLanguageFromPath(clean(args.file_path ?? args.path ?? args.filepath));
  const lines = language
    ? highlightCode(content, language)
    : content.split("\n").map((line) => theme.fg("toolOutput", line));
  const shown = context.expanded ? lines : lines.slice(0, 10);
  const remaining = lines.length - shown.length;
  return `${shown.join("\n")}${remaining > 0 ? theme.fg("muted", `\n... (${remaining} more lines)`) : ""}`;
}

function writeCall(rawArgs: unknown, theme: Theme, context: AnyContext) {
  const args = parseArgsObject(rawArgs ?? context?.args);
  const title = headerText(
    context.expanded ? "-" : "+",
    "WRITE",
    ` ${displayPath(args.file_path ?? args.path ?? args.filepath, context.cwd)}`,
    theme,
  );
  if (!context.expanded) return new CompactText(title);

  const body = formatWriteContent(args, theme, context);
  return body ? CompactText.headerAndDetail(title, body) : new CompactText(title);
}

function executionCall(sandbox: boolean) {
  return (rawArgs: unknown, theme: Theme, context: AnyContext) => {
    const args = parseArgsObject(rawArgs ?? context?.args);
    const command = clean(args.command ?? args.cmd) || "...";
    const label = sandbox ? "BASH(SANDBOX)" : "BASH";
    const marker = context.expanded ? "-" : "+";
    return new CompactText(theme.fg("muted", `${marker} `) + theme.fg(sandbox ? "success" : "toolTitle", theme.bold(label.padEnd(16))) + theme.fg("text", command));
  };
}

function executionResult(base: AnyDefinition) {
  return (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
    if (!options.expanded && !context.isError) return empty();
    if (!base.renderResult) return empty();
    return base.renderResult(result, options, theme, context as never);
  };
}

export function registerFileToolUi(pi: ExtensionAPI, cwd: string): void {
  const read = createReadToolDefinition(cwd);
  const edit = createEditToolDefinition(cwd);
  const write = createWriteToolDefinition(cwd);

  pi.registerTool({ ...read, renderShell: "default", renderCall: fileCall("READ"), renderResult: fileResult("read", read) });
  pi.registerTool({ ...edit, renderShell: "default", renderCall: fileCall("EDIT"), renderResult: fileResult("edit", edit) });
  pi.registerTool({ ...write, renderShell: "default", renderCall: writeCall, renderResult: fileResult("write", write) });
}

export function createSandboxBashTool(cwd: string, operations: BashOperations): AnyDefinition {
  const base = createBashToolDefinition(cwd, { operations });
  return {
    ...base,
    renderShell: "default",
    renderCall: executionCall(true),
    renderResult: executionResult(base),
    name: "bash",
    label: "bash (sandboxed)",
  };
}

function mcpProvider(name: string): string {
  const first = (name.split(/[_/:]/, 1)[0] ?? name) || name;
  return first.replace(/-/g, " ").toUpperCase();
}

const MCP_TARGET_KEYS = ["query", "search", "keyword", "text", "message", "prompt", "term", "url", "path", "id", "name"];

function mcpTarget(args: Record<string, unknown>, name: string): string {
  for (const key of MCP_TARGET_KEYS) {
    const v = args?.[key];
    if (typeof v === "string" && v.trim()) {
      const one = v.trim().replace(/\s+/g, " ");
      return one.length > 60 ? `${one.slice(0, 57)}…` : one;
    }
  }
  return name;
}

/** Compact tool-style header for an MCP call, matching the built-in file/exec tools. */
function createMcpDefinition(name: string, cwd: string): AnyDefinition {
  const base = createReadToolDefinition(cwd);
  return {
    ...base,
    name,
    label: name,
    renderShell: "default",
    renderCall: (rawArgs: unknown, theme: Theme, context: AnyContext) => {
      const args = parseArgsObject(rawArgs ?? context?.args);
      const marker = context.expanded ? "-" : "+";
      return new CompactText(
        theme.fg("muted", marker) +
          " " +
          theme.fg("toolTitle", theme.bold(mcpProvider(name).padEnd(7))) +
          theme.fg("text", ` ${mcpTarget(args, name)}`),
      );
    },
    renderResult: (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, _context: AnyContext) => {
      if (!options.expanded) return empty();
      const text = textResult(result);
      return text
        ? new CompactText(theme.fg("toolOutput", text), "detail")
        : empty();
    },
  };
}

export function getCustomToolDefinition(name: string, cwd: string = process.cwd()): AnyDefinition | undefined {
  if (name === "read") {
    const read = createReadToolDefinition(cwd);
    return { ...read, renderShell: "default", renderCall: fileCall("READ"), renderResult: fileResult("read", read) };
  }
  if (name === "edit") {
    const edit = createEditToolDefinition(cwd);
    return { ...edit, renderShell: "default", renderCall: fileCall("EDIT"), renderResult: fileResult("edit", edit) };
  }
  if (name === "write") {
    const write = createWriteToolDefinition(cwd);
    return { ...write, renderShell: "default", renderCall: writeCall, renderResult: fileResult("write", write) };
  }
  if (name === "bash") {
    const bash = createBashToolDefinition(cwd);
    return {
      ...bash,
      renderShell: "default",
      renderCall: executionCall(true),
      renderResult: executionResult(bash),
      name: "bash",
      label: "bash (sandboxed)",
    };
  }
  // MCP capability tools: render with a compact tool-style header like the built-ins.
  return createMcpDefinition(name, cwd);
}

export function setupFileToolUi(pi: ExtensionAPI): void {
  registerFileToolUi(pi, process.cwd());
  pi.on("session_start", (_event, ctx) => registerFileToolUi(pi, ctx.cwd));
}
