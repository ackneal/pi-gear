import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getLanguageFromPath,
  highlightCode,
  keyHint,
  truncateToVisualLines,
  renderDiff,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, getCapabilities, getImageDimensions, imageFallback, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { NormalizedDiagnostic, SourceLocation } from "../../lsp/types.ts";

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

function headerText(marker: "+" | "-" | "✓", label: string, target: string, theme: Theme): string {
  const markerColor = marker === "✓" ? "success" : "muted";
  return `${theme.fg(markerColor, marker)} ${theme.fg("toolTitle", theme.bold(label.padEnd(LABEL_WIDTH)))}${theme.fg("text", target)}`;
}

function header(marker: "+" | "-" | "✓", label: string, target: string, theme: Theme): CompactText {
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

const count = (value: number, noun: string): string => `${value} ${value === 1 ? noun : `${noun}s`}`;

function diagnosticsSummary(diagnostics: readonly NormalizedDiagnostic[]): string {
  const errors = diagnostics.filter(({ severity }) => severity === "error").length;
  const warnings = diagnostics.filter(({ severity }) => severity === "warning").length;
  const suggestions = diagnostics.length - errors - warnings;
  return [
    errors > 0 ? count(errors, "error") : undefined,
    warnings > 0 ? count(warnings, "warning") : undefined,
    suggestions > 0 ? count(suggestions, "suggestion") : undefined,
  ].filter((item): item is string => item !== undefined).join(" · ");
}

function diagnosticLine(diagnostic: NormalizedDiagnostic): string {
  const identity = [diagnostic.severity, diagnostic.source, diagnostic.code].filter(Boolean).join(" ");
  return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${identity}] ${diagnostic.message}`;
}

function navigationLabel(args: unknown): "DEFINITION" | "REFERENCES" | "NAVIGATION" {
  const action = parseArgsObject(args).action;
  if (action === "definition") return "DEFINITION";
  if (action === "references") return "REFERENCES";
  return "NAVIGATION";
}

function lspCall(kind: "diagnostics" | "navigation") {
  return (rawArgs: unknown, theme: Theme, context: AnyContext) => {
    const label = kind === "diagnostics" ? "DIAGNOSTICS" : navigationLabel(rawArgs ?? context.args);
    if (!context.isPartial && !context.isError) return empty();
    return header(context.expanded ? "-" : "+", label, "", theme);
  };
}

function diagnosticsResult(result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) {
  if (context.isError) {
    const text = textResult(result);
    return text ? new CompactText(theme.fg("error", text), "detail") : empty();
  }

  const diagnostics = Array.isArray(result.details?.diagnostics)
    ? result.details.diagnostics as NormalizedDiagnostic[]
    : [];
  const qualifier = parseArgsObject(context.args).scope === "workspace" ? "workspace" : "";
  if (diagnostics.length === 0) return header("✓", "DIAGNOSTICS", qualifier ? ` ${qualifier}` : "", theme);

  const summary = [qualifier, diagnosticsSummary(diagnostics)].filter(Boolean).join(" ");
  const title = headerText(options.expanded ? "-" : "+", "DIAGNOSTICS", ` ${summary}`, theme);
  if (!options.expanded) return new CompactText(title);
  return CompactText.headerAndDetail(title, `\n${diagnostics.map(diagnosticLine).join("\n")}`);
}

function navigationResult(result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) {
  if (context.isError) {
    const text = textResult(result);
    return text ? new CompactText(theme.fg("error", text), "detail") : empty();
  }

  const label = navigationLabel(context.args);
  const locations = Array.isArray(result.details?.locations)
    ? result.details.locations as SourceLocation[]
    : [];
  if (locations.length === 0) {
    return header("✓", label, label === "DEFINITION" ? " no result" : " no results", theme);
  }

  const title = headerText(options.expanded ? "-" : "+", label, ` ${count(locations.length, "location")}`, theme);
  if (!options.expanded) return new CompactText(title);
  const lines = locations.map(({ path, line, column }) => `${path}:${line}:${column}`).join("\n");
  return CompactText.headerAndDetail(title, `\n${lines}`);
}

type WorkspaceToolKind = "find" | "grep";

function workspaceCall(kind: WorkspaceToolKind) {
  return (rawArgs: unknown, theme: Theme, context: AnyContext) => {
    const args = parseArgsObject(rawArgs ?? context?.args);
    const label = kind.toUpperCase();
    const path = displayPath(args.path ?? ".", context.cwd);
    const query = clean(args.pattern);
    const target = [path === "." ? undefined : path, query || undefined].filter(Boolean).join(" · ");
    return header(context.expanded ? "-" : "+", label, target ? ` ${target}` : "", theme);
  };
}

function workspaceResult(kind: WorkspaceToolKind) {
  return (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
    const text = textResult(result);
    if (context.isError) return text ? new CompactText(theme.fg("error", text), "detail") : empty();

    if (!options.expanded || !text) return empty();
    return new CompactText(theme.fg("toolOutput", `\n${text}`), "detail");
  };
}

export function workspaceToolRenderers(kind: WorkspaceToolKind): Pick<AnyDefinition, "renderShell" | "renderCall" | "renderResult"> {
  return {
    renderShell: "default",
    renderCall: workspaceCall(kind),
    renderResult: workspaceResult(kind),
  };
}

export function lspToolRenderers(kind: "diagnostics" | "navigation"): Pick<AnyDefinition, "renderShell" | "renderCall" | "renderResult"> {
  return {
    renderShell: "default",
    renderCall: lspCall(kind),
    renderResult: kind === "diagnostics" ? diagnosticsResult : navigationResult,
  };
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

/** Native-style MCP preview, bounded by visual rather than logical lines. */
class McpPreview {
  private text: string;
  private theme: Theme;
  constructor(text: string, theme: Theme) {
    this.text = text;
    this.theme = theme;
  }
  render(width: number): string[] {
    const safeWidth = Math.max(1, width);
    const { visualLines, skippedCount } = truncateToVisualLines(this.text, 5, safeWidth, 0, "start");
    if (skippedCount > 0) {
      const hint = `${this.theme.fg("muted", `... (${skippedCount} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${this.theme.fg("muted", ")")}`;
      visualLines.push(truncateToWidth(hint, safeWidth, safeWidth < 3 ? "" : "..."));
    }
    return visualLines;
  }
  invalidate(): void {}
}

function createMcpDefinition(name: string, cwd: string): AnyDefinition {
  const base = createReadToolDefinition(cwd);
  const parts = name.slice("mcp__".length).split("__");
  const label = `${parts.shift()}/${parts.join("__")}`;
  return {
    ...base,
    name,
    label,
    renderShell: "default",
    renderCall: (rawArgs: unknown, theme: Theme, context: AnyContext) => {
      const args = rawArgs ?? context.args;
      const entries = args == null ? [] : typeof args === "object" && !Array.isArray(args)
        ? Object.entries(args) : [["args", args]];
      let text = theme.fg("toolTitle", theme.bold(label));
      if (entries.length > 0) {
        if (context.expanded) {
          const lines = entries.map(([key, value]) => {
            const valueText = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
            return `  ${key}: ${valueText.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
          });
          text += `\n${theme.fg("muted", lines.join("\n"))}`;
        } else {
          const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
          text += ` ${theme.fg("muted", pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs)}`;
        }
      }
      const component = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
      component.setText(text);
      return component;
    },
    renderResult: (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
      const component = context.lastComponent instanceof Container ? context.lastComponent : new Container();
      component.clear();
      // Match Pi's binary filter; its sanitizeBinaryOutput helper is not a public export.
      let output = result.content.filter((item) => item.type === "text")
        .map((item) => stripVTControlCharacters((item.text || "")
          // Node's stripper misses Pi's general OSC strings and colon-separated SGR parameters.
          .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\|\u009c)/g, "")
          .replace(/(?:\x1b\[|\u009b)\d{1,4}(?:[;:]\d{0,4})*m/g, ""))
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "").replace(/\r/g, ""))
        .join("\n");
      if (!getCapabilities().images || !context.showImages) {
        const images = result.content.filter((item) => item.type === "image").map((image) =>
          imageFallback(image.mimeType ?? "image/unknown", getImageDimensions(image.data, image.mimeType) ?? undefined));
        output = [output, ...images].filter(Boolean).join("\n");
      }
      output = output.trim();
      if (!output) return component;
      const styled = output.replace(/\t/g, "   ").split("\n")
        .map((line) => theme.fg(context.isError ? "error" : "toolOutput", line)).join("\n");
      component.addChild(new Spacer(1));
      if (options.expanded) {
        component.addChild(new Text(styled, 0, 0));
      } else {
        component.addChild(new McpPreview(styled, theme));
        if (result.details?.fullOutputPath) {
          component.addChild(new Text(theme.fg("muted", `Full output: ${result.details.fullOutputPath}`), 0, 0));
        }
      }
      return component;
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
  if (name === "find" || name === "grep") {
    const base: AnyDefinition = createReadToolDefinition(cwd);
    return { ...base, name, ...workspaceToolRenderers(name) };
  }
  if (name.startsWith("mcp__")) {
    return createMcpDefinition(name, cwd);
  }
  return undefined;
}

export function setupFileToolUi(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => registerFileToolUi(pi, ctx.cwd));
}
