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
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

const LABEL_WIDTH = 16;

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

type TextMode = "compact" | "detail" | "raw";
type TextBlock = { value: string; mode: TextMode; truncatedHint: string | undefined };

class CompactText {
  private blocks: TextBlock[];
  constructor(value: string, mode: TextMode = "compact", truncatedHint?: string) {
    this.blocks = [{ value, mode, truncatedHint }];
  }
  static headerAndDetail(header: string, detail: string, headerHint?: string): CompactText {
    const component = new CompactText("");
    component.blocks = [
      { value: header, mode: "compact", truncatedHint: headerHint },
      { value: detail, mode: "detail", truncatedHint: undefined },
    ];
    return component;
  }
  static headerAndLines(header: string, raw: string, headerHint?: string): CompactText {
    const component = new CompactText("");
    component.blocks = [
      { value: header, mode: "compact", truncatedHint: headerHint },
      { value: raw, mode: "raw", truncatedHint: undefined },
    ];
    return component;
  }
  render(width: number): string[] {
    const lineWidth = Math.max(1, width);
    return this.blocks.flatMap(({ value, mode, truncatedHint }) => {
      if (!value.trim()) return [];
      // Raw: keep each original line intact (段行), but bound width so a runaway
      // line can't exceed the terminal and crash the renderer.
      if (mode === "raw") {
        return value.split("\n").map((line) => truncateToWidth(line, lineWidth, "…"));
      }
      return value.split("\n").flatMap((line) =>
        mode === "compact"
          ? truncateOneLine(line, lineWidth, truncatedHint)
          : line === ""
            ? [""]
            : wrapTextWithAnsi(line, lineWidth),
      );
    });
  }
  invalidate(): void {}
}

function truncateOneLine(line: string, lineWidth: number, hint?: string): string[] {
  if (visibleWidth(line) <= lineWidth) return [line];
  // Default: single ellipsized line. With a hint (e.g. "(truncated)"), reserve
  // room for it so the marker stays visible instead of being cut off.
  if (!hint) return [truncateToWidth(line, lineWidth, "…")];
  const hintWidth = visibleWidth(hint);
  return [truncateToWidth(line, Math.max(1, lineWidth - hintWidth), "…") + hint];
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
  return `${theme.fg("muted", marker)} ${theme.fg("toolTitle", theme.bold(label.padEnd(LABEL_WIDTH)))}${theme.fg("text", target)}`;
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
    const head =
      theme.fg("muted", `${marker} `) +
      theme.fg(sandbox ? "success" : "toolTitle", theme.bold(label.padEnd(LABEL_WIDTH)));
    if (!context.expanded) {
      return new CompactText(
        head + theme.fg("text", ` ${command}`),
        "compact",
        theme.fg("muted", "(truncated)"),
      );
    }
    // Expanded: full command as raw line(s) (break only on newlines, no mid-token
    // wrapping), with a trailing blank separating it from the result.
    return CompactText.headerAndLines(head, `${theme.fg("text", command)}\n`);
  };
}

function executionResult(base: AnyDefinition) {
  return (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
    if (!options.expanded && !context.isError) return empty();
    if (!base.renderResult) return empty();
    return base.renderResult(result, options, theme, context as never);
  };
}

type FileToolKind = "read" | "edit" | "write";

function createFileToolDefinition(kind: FileToolKind, cwd: string): AnyDefinition {
  if (kind === "read") {
    const base = createReadToolDefinition(cwd);
    return { ...base, renderShell: "default", renderCall: fileCall("READ"), renderResult: fileResult(kind, base) };
  }
  if (kind === "edit") {
    const base = createEditToolDefinition(cwd);
    return { ...base, renderShell: "default", renderCall: fileCall("EDIT"), renderResult: fileResult(kind, base) };
  }

  const base = createWriteToolDefinition(cwd);
  return { ...base, renderShell: "default", renderCall: writeCall, renderResult: fileResult(kind, base) };
}

export function registerFileToolUi(pi: ExtensionAPI, cwd: string): void {
  for (const kind of ["read", "edit", "write"] as const) {
    pi.registerTool(createFileToolDefinition(kind, cwd));
  }
}

function decorateSandboxBash(base: AnyDefinition): AnyDefinition {
  return {
    ...base,
    renderShell: "default",
    renderCall: executionCall(true),
    renderResult: executionResult(base),
    name: "bash",
    label: "bash (sandboxed)",
  };
}

export function createSandboxBashTool(cwd: string, operations: BashOperations): AnyDefinition {
  return decorateSandboxBash(createBashToolDefinition(cwd, { operations }));
}

function mcpToolName(name: string): string {
  const i = name.indexOf("_");
  return i === -1 ? name : name.slice(i + 1);
}

const MCP_TARGET_KEYS = ["query", "search", "keyword", "text", "message", "prompt", "term", "url", "path", "id", "name"];

function mcpTarget(args: Record<string, unknown>, name: string): string {
  for (const key of MCP_TARGET_KEYS) {
    const v = args?.[key];
    if (typeof v === "string" && v.trim()) {
      return v.trim().replace(/\s+/g, " ");
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
      const label = `MCP(${mcpToolName(name)})`;
      const head =
        theme.fg("muted", marker) +
        " " +
        theme.fg("toolTitle", theme.bold(label.padEnd(LABEL_WIDTH)));
      const target = mcpTarget(args, name);
      if (!context.expanded) {
        return new CompactText(
          head + theme.fg("text", ` ${target}`),
          "compact",
          theme.fg("muted", "(truncated)"),
        );
      }
      // Expanded: full target as a raw line (no mid-token wrapping).
      return CompactText.headerAndLines(head, theme.fg("text", target));
    },
    renderResult: (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, _context: AnyContext) => {
      if (!options.expanded) return empty();
      const text = textResult(result);
      return text
        ? new CompactText(`\n${theme.fg("toolOutput", text)}`, "detail")
        : empty();
    },
  };
}

export function getCustomToolDefinition(name: string, cwd: string = process.cwd()): AnyDefinition | undefined {
  if (name === "read" || name === "edit" || name === "write") {
    return createFileToolDefinition(name, cwd);
  }
  if (name === "bash") {
    return decorateSandboxBash(createBashToolDefinition(cwd));
  }
  // MCP capability tools: render with a compact tool-style header like the built-ins.
  return createMcpDefinition(name, cwd);
}

export function setupFileToolUi(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => registerFileToolUi(pi, ctx.cwd));
}
