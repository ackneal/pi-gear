import { configureOutputPadding, indentDetails, paddedRenderer } from "./padding.ts";
import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  getLanguageFromPath,
  getMarkdownTheme,
  keyText,
  highlightCode,
  renderDiff,
  type AgentToolResult,
  type ExtensionAPI,
  type Theme,
  type ToolDefinition,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { stripVTControlCharacters } from "node:util";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, Container, Spacer, Text, getCapabilities, getImageDimensions, imageFallback, truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import type { NormalizedDiagnostic, SourceLocation } from "../../lsp/types.ts";
import { statusMark, summaryLine, titleCase, titleLine, toolStatus, type ToolStatus } from "./row.ts";

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
  render(width: number): string[] {
    const lineWidth = Math.max(1, width);
    return this.blocks.flatMap(({ value, mode, truncatedHint }) => {
      if (!value.trim()) return [];
      return value.split("\n").flatMap((line) =>
        mode === "compact"
          ? truncateOneLine(line, lineWidth, truncatedHint)
          : line === ""
            ? [""]
            : wrapTextWithAnsi(line, Math.max(1, lineWidth - 2)).map((part) => " ".repeat(Math.min(2, Math.max(0, lineWidth - 1))) + part),
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
  if (hintWidth >= lineWidth) return [truncateToWidth(line, lineWidth, "…")];
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

function headerText(status: ToolStatus, label: string, target: string, theme: Theme): string {
  return titleLine(status, titleCase(label), target, theme);
}

function header(status: ToolStatus, label: string, target: string, theme: Theme): CompactText {
  return new CompactText(headerText(status, label, target, theme));
}

function summary(text: string, theme: Theme, color: "muted" | "error" = "muted"): CompactText {
  return new CompactText(summaryLine(text, theme, color));
}

function outputLines(text: string): string[] {
  return stripVTControlCharacters(text).split(/\r\n|[\r\n]/).map((line) => line.trim()).filter(Boolean);
}

/** Collapsed errors keep one line; the full message stays available when expanded. */
function errorResult(text: string, options: ToolRenderResultOptions, theme: Theme): CompactText {
  if (!text.trim()) return empty();
  if (options.expanded) return new CompactText(theme.fg("error", text), "detail");
  return summary(outputLines(text)[0] ?? "", theme, "error");
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

function skillPath(args: Record<string, unknown>): string | undefined {
  const path = args.file_path ?? args.path ?? args.filepath;
  return typeof path === "string" && basename(path) === "SKILL.md" ? path : undefined;
}

function skillBox(component: Component, theme: Theme, previous?: unknown): Box {
  const box = previous instanceof Box ? previous : new Box(1, 0);
  box.setBgFn((text) => theme.bg("customMessageBg", text));
  box.clear();
  box.addChild(component);
  return box;
}

function fileCall(label: string) {
  return (rawArgs: unknown, theme: Theme, context: AnyContext) => {
    const args = parseArgsObject(rawArgs ?? context?.args);
    const skill = label === "READ" ? skillPath(args) : undefined;
    if (skill) {
      const status = toolStatus(context);
      const state = status === "success" ? "" : `${statusMark(status, theme)} `;
      const label = theme.fg("customMessageLabel", theme.bold("[skill]"));
      const name = state + theme.fg("customMessageText", `${basename(dirname(skill))}${readRange(args)}`);
      const expandedStatus = state || readRange(args) ? ` ${name}` : "";
      return skillBox(new Text(
        "\n" + label + (context.expanded ? expandedStatus : ` ${name}${theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`)}\n`), 0, 0,
      ), theme, context.lastComponent);
    }
    const suffix = label === "READ" ? readRange(args) : "";
    return header(toolStatus(context), label, `${displayPath(args.file_path ?? args.path ?? args.filepath, context.cwd)}${suffix}`, theme);
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
    return header(toolStatus(context), label, "", theme);
  };
}

function diagnosticsResult(result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) {
  if (context.isError) return errorResult(textResult(result), options, theme);

  const diagnostics = Array.isArray(result.details?.diagnostics)
    ? result.details.diagnostics as NormalizedDiagnostic[]
    : [];
  const qualifier = parseArgsObject(context.args).scope === "workspace" ? "workspace" : "";
  const title = headerText(toolStatus(context), "DIAGNOSTICS", qualifier, theme);
  if (diagnostics.length === 0) return new CompactText(`${title}\n${summaryLine("no issues", theme)}`);

  const head = `${title}\n${summaryLine(diagnosticsSummary(diagnostics), theme)}`;
  if (!options.expanded) return new CompactText(head);
  return CompactText.headerAndDetail(head, `\n${diagnostics.map(diagnosticLine).join("\n")}`);
}

function navigationResult(result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) {
  if (context.isError) return errorResult(textResult(result), options, theme);

  const label = navigationLabel(context.args);
  const locations = Array.isArray(result.details?.locations)
    ? result.details.locations as SourceLocation[]
    : [];
  const status = headerText(toolStatus(context), label, "", theme);
  if (locations.length === 0) {
    return new CompactText(`${status}\n${summaryLine(label === "DEFINITION" ? "no result" : "no results", theme)}`);
  }

  const title = `${status}\n${summaryLine(count(locations.length, "location"), theme)}`;
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
    return header(toolStatus(context), label, target, theme);
  };
}

function workspaceResult() {
  return (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
    const text = textResult(result);
    if (context.isError) return errorResult(text, options, theme);
    if (!text) return empty();
    if (!options.expanded) return summary(count(outputLines(text).length, "result"), theme);
    return new CompactText(theme.fg("toolOutput", `\n${text}`), "detail");
  };
}

export function workspaceToolRenderers(
  kind: WorkspaceToolKind,
): Pick<AnyDefinition, "renderShell" | "renderCall" | "renderResult"> {
  const callFn = workspaceCall(kind);
  const resultFn = workspaceResult();

  return { renderShell: "self", renderCall: paddedRenderer(callFn), renderResult: paddedRenderer(resultFn) };
}

export function lspToolRenderers(
  kind: "diagnostics" | "navigation",
): Pick<AnyDefinition, "renderShell" | "renderCall" | "renderResult"> {
  const callFn = lspCall(kind);
  const resultFn = kind === "diagnostics" ? diagnosticsResult : navigationResult;

  return { renderShell: "self", renderCall: paddedRenderer(callFn), renderResult: paddedRenderer(resultFn) };
}

function fileResult(kind: "read" | "edit" | "write", base: AnyDefinition) {
  return (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
    const text = textResult(result);
    if (context.isError) return errorResult(text, options, theme);

    if (kind === "read") {
      const args = parseArgsObject(context.args);
      if (skillPath(args) && result.content.every((item) => item.type === "text")) {
        if (!options.expanded) {
          return result.details?.truncation?.truncated || /\[(?:Showing|Output truncated|\d+ more lines? in file\.)/.test(text)
            ? summary("Partial skill · expand to view read limits", theme)
            : empty();
        }
        const startsAtBeginning = args.offset == null || args.offset === 1;
        const content = startsAtBeginning ? text.replace(/^---\r?\n(?:.*\r?\n)*?---(?:\r?\n|$)/, "") : text;
        const path = skillPath(args)!;
        const name = basename(dirname(path));
        const expandedPath = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
        const directory = isAbsolute(expandedPath) ? dirname(expandedPath) : resolve(context.cwd, dirname(expandedPath));
        const body = new Container();
        body.addChild(new Markdown(`**${name}**\n\nReferences are relative to ${directory}.\n\n${content}`, 0, 0, getMarkdownTheme(), {
          color: (value) => theme.fg("customMessageText", value),
        }));
        body.addChild(new Spacer(1));
        return skillBox(body, theme, context.lastComponent);
      }
      if (options.expanded && base.renderResult) {
        const lastComponent = context.lastComponent instanceof Text ? context.lastComponent : undefined;
        return indentDetails(base.renderResult(result, options, theme, { ...context, lastComponent } as never), true);
      }
      const images = result.content.filter((item) => item.type === "image").length;
      return summary(images > 0 ? count(images, "image") : count(text.split("\n").length, "line"), theme);
    }

    if (kind === "edit") {
      if (typeof result.details?.diff !== "string") return empty();
      if (!options.expanded) return summary(diffStat(result.details.diff), theme);
      return new CompactText(renderDiff(result.details.diff, { filePath: displayPath((context.args as Record<string, unknown>).path, context.cwd) }), "detail");
    }

    const content = parseArgsObject(context.args).content;
    if (options.expanded || typeof content !== "string") return empty();
    return summary(`Wrote ${count(content.split("\n").length, "line")}`, theme);
  };
}

function diffStat(diff: string): string {
  const lines = diff.split("\n");
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  return `+${added} −${removed}`;
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
    toolStatus(context),
    "WRITE",
    displayPath(args.file_path ?? args.path ?? args.filepath, context.cwd),
    theme,
  );
  if (!context.expanded) return new CompactText(title);

  const body = formatWriteContent(args, theme, context);
  return body ? CompactText.headerAndDetail(title, body) : new CompactText(title);
}

export function executionCall(labelOverride?: string) {
  return (rawArgs: unknown, theme: Theme, context: AnyContext) => {
    const state = context?.state && typeof context.state === "object"
      ? (context.state as Record<string, unknown>)
      : undefined;
    if (context?.executionStarted && state && state.startedAt === undefined) {
      state.startedAt = Date.now();
      state.endedAt = undefined;
    }
    const args = parseArgsObject(rawArgs ?? context?.args);
    const rawCommand = args.command ?? args.cmd;
    const command = typeof rawCommand === "string" ? stripVTControlCharacters(rawCommand).replace(/\r\n?/g, "\n").replace(/\t/g, "  ") : "...";
    const label = labelOverride ?? "BASH";
    const status = toolStatus(context);
    if (!context.expanded) {
      return new CompactText(
        headerText(status, label, clean(command), theme),
        "compact",
        theme.fg("muted", "(truncated)"),
      );
    }
    return CompactText.headerAndDetail(headerText(status, label, "", theme), theme.fg("text", command));
  };
}

export type BaseResultRenderer = {
  renderResult?: ((result: any, options: ToolRenderResultOptions, theme: Theme, context: any) => Component) | undefined;
};

export function executionResult(base: BaseResultRenderer) {
  return (result: AnyResult, options: ToolRenderResultOptions, theme: Theme, context: AnyContext) => {
    if (!options.isPartial && context.state && typeof context.state === "object") {
      const state = context.state as Record<string, unknown>;
      if (state.interval !== undefined) {
        clearInterval(state.interval as ReturnType<typeof setInterval>);
        delete state.interval;
      }
      state.endedAt ??= Date.now();
    }
    if (options.expanded) {
      return base.renderResult ? indentDetails(base.renderResult(result, options, theme, context as never), true) : empty();
    }

    // The native shell renderer reuses lastComponent as a Container on expansion.
    const container = new Container();
    const last = outputLines(textResult(result)).at(-1);
    if (last) container.addChild(summary(last, theme, context.isError ? "error" : "muted"));
    return container;
  };
}

export function executionToolRenderers(
  base: BaseResultRenderer,
  options: { label?: string } = {},
): Pick<AnyDefinition, "renderShell" | "renderCall" | "renderResult"> {
  const callFn = executionCall(options.label);
  const resultFn = executionResult(base);

  return { renderShell: "self", renderCall: paddedRenderer(callFn), renderResult: paddedRenderer(resultFn) };
}

type FileToolKind = "read" | "edit" | "write";

function createFileToolDefinition(
  kind: FileToolKind,
  cwd: string,
): AnyDefinition {
  const base: AnyDefinition = kind === "read"
    ? createReadToolDefinition(cwd)
    : kind === "edit"
      ? (createEditToolDefinition(cwd) as AnyDefinition)
      : createWriteToolDefinition(cwd);
  const callFn = kind === "write" ? writeCall : fileCall(kind.toUpperCase());
  const resultFn = fileResult(kind, base);
  const paddedCall = paddedRenderer(callFn);
  const paddedResult = paddedRenderer(resultFn);

  return {
    ...base,
    renderShell: "self",
    renderCall: (args, theme, context) => kind === "read" && skillPath(parseArgsObject(args ?? context.args))
      ? callFn(args, theme, context)
      : paddedCall(args, theme, context),
    renderResult: (result, options, theme, context) => kind === "read" && skillPath(parseArgsObject(context.args))
      ? resultFn(result, options, theme, context)
      : paddedResult(result, options, theme, context),
  };
}

export function registerFileToolUi(
  pi: ExtensionAPI,
  cwd: string,
): void {
  configureOutputPadding(pi);
  for (const kind of ["read", "edit", "write"] as const) {
    pi.registerTool(createFileToolDefinition(kind, cwd));
  }
}

function decorateSandboxBash(
  base: AnyDefinition,
): AnyDefinition {
  return {
    ...base,
    ...executionToolRenderers(base),
    name: "bash",
    label: "bash (sandboxed)",
  };
}

export function createSandboxBashTool(
  cwd: string,
  operations: BashOperations,
): AnyDefinition {
  return decorateSandboxBash(createBashToolDefinition(cwd, { operations }));
}

function createMcpDefinition(name: string, cwd: string): AnyDefinition {
  const base = createReadToolDefinition(cwd);
  const parts = name.slice("mcp__".length).split("__");
  const label = `${parts.shift()}/${parts.join("__")}`;
  return {
    ...base,
    name,
    label,
    renderShell: "self",
    renderCall: (rawArgs: unknown, theme: Theme, context: AnyContext) => {
      const args = rawArgs ?? context.args;
      const entries = args == null ? [] : typeof args === "object" && !Array.isArray(args)
        ? Object.entries(args) : [["args", args]];
      const status = toolStatus(context);
      let text = titleLine(status, label, "", theme);
      if (entries.length > 0) {
        if (context.expanded) {
          const lines = entries.map(([key, value]) => {
            const valueText = typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? String(value));
            return `  ${key}: ${valueText.replace(/\t/g, "   ").replace(/\r/g, "").split("\n").join("\n    ")}`;
          });
          text += `\n${theme.fg("muted", lines.join("\n"))}`;
        } else {
          const pairs = entries.map(([key, value]) => `${key}=${JSON.stringify(value) ?? String(value)}`).join(" ");
          text = titleLine(status, label, pairs.length > 100 ? `${pairs.slice(0, 97)}...` : pairs, theme);
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
          .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\uFFF9-\uFFFB]/g, "").replace(/\r/g, "").replace(/\t/g, "   "))
        .join("\n");
      if (!getCapabilities().images || !context.showImages) {
        const images = result.content.filter((item) => item.type === "image").map((image) =>
          imageFallback(image.mimeType ?? "image/unknown", getImageDimensions(image.data, image.mimeType) ?? undefined));
        output = [output, ...images].filter(Boolean).join("\n");
      }
      output = output.trim();
      if (!output) return component;

      if (!options.expanded) {
        const lines = outputLines(output);
        const text = lines.length > 1 ? `${lines[0]} · ${count(lines.length, "line")}` : lines[0] ?? "";
        component.addChild(summary(text, theme, context.isError ? "error" : "muted"));
        if (result.details?.fullOutputPath) {
          component.addChild(summary(`Full output: ${result.details.fullOutputPath}`, theme));
        }
        return component;
      }

      const styled = output.replace(/\t/g, "   ").split("\n")
        .map((line) => theme.fg(context.isError ? "error" : "toolOutput", line)).join("\n");
      component.addChild(new Text(styled, 2, 0));
      if (result.details?.fullOutputPath) {
        component.addChild(new Text(theme.fg("muted", `Full output: ${result.details.fullOutputPath}`), 2, 0));
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
  if (name === "diagnostics" || name === "navigation") {
    const base: AnyDefinition = createReadToolDefinition(cwd);
    return { ...base, name, ...lspToolRenderers(name) };
  }
  if (name.startsWith("mcp__")) {
    const definition = createMcpDefinition(name, cwd);
    definition.renderCall = paddedRenderer(definition.renderCall!);
    definition.renderResult = paddedRenderer(definition.renderResult!);
    return definition;
  }
  return undefined;
}

export function setupFileToolUi(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => registerFileToolUi(pi, ctx.cwd));
}
