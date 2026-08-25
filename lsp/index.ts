import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadExtensionConfig } from "../config/index.ts";
import type { LspServerSummary } from "../commands/doctor.ts";
import { formatDiagnostics } from "./normalize.ts";
import { LspManager } from "./manager.ts";
import type { NormalizedDiagnostic } from "./types.ts";

export interface LspServices {
  statuses(cwd: string): Promise<readonly LspServerSummary[]>;
}

type FileToolResultEvent = {
  readonly toolName: string;
  readonly isError: boolean;
  readonly input: Record<string, unknown>;
  readonly content: readonly any[];
};

const diagnosticCount = (count: number, singular: string): string =>
  `${count} ${count === 1 ? singular : `${singular}s`}`;

function formatAutomaticDiagnostics(diagnostics: readonly NormalizedDiagnostic[]): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warningCount = diagnostics.filter((diagnostic) => diagnostic.severity === "warning").length;
  const suggestionCount = diagnostics.length - errors.length - warningCount;
  const counts = [
    errors.length > 0 ? diagnosticCount(errors.length, "error") : undefined,
    warningCount > 0 ? diagnosticCount(warningCount, "warning") : undefined,
    suggestionCount > 0 ? diagnosticCount(suggestionCount, "suggestion") : undefined,
  ].filter((count): count is string => count !== undefined).join(" · ");
  const details = errors.map((diagnostic) => {
    const code = diagnostic.code ? ` ${diagnostic.code}` : "";
    return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [error${code}] ${diagnostic.message}`;
  });

  return ["LSP", counts, ...details].join("\n");
}

export async function primeLspDiagnostics(manager: LspManager, path: string): Promise<void> {
  try {
    await manager.primeDiagnostics(path);
  } catch {}
}

export async function lspDiagnosticsPatch(manager: LspManager, event: FileToolResultEvent): Promise<{ content: any[] } | undefined> {
  if (event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
  const path = event.input.path;
  if (typeof path !== "string" || !manager.match(path)) return;

  try {
    const diagnostics = await manager.changedDiagnostics(path);
    if (diagnostics.length === 0) return;

    return {
      content: [...event.content, { type: "text", text: formatAutomaticDiagnostics(diagnostics) }],
    };
  } catch {
    return;
  }
}

const diagnosticsParameters = Type.Object({
  scope: Type.Optional(Type.Union([Type.Literal("changed"), Type.Literal("workspace")])),
}, { additionalProperties: false });

const navigationParameters = Type.Object({
  action: Type.Union([Type.Literal("definition"), Type.Literal("references")]),
  path: Type.String(),
  line: Type.Integer({ minimum: 1 }),
  column: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });

export function setupLsp(
  pi: ExtensionAPI,
  loadConfig: typeof loadExtensionConfig = loadExtensionConfig,
): LspServices {
  let manager: LspManager | undefined;

  pi.on("session_start", async (_event, ctx) => {
    const config = await loadConfig();
    if (!config.lsp || config.lsp.servers.length === 0) return;

    manager = new LspManager(config.lsp.servers, ctx.cwd, undefined, config, config.lsp.idleTimeoutMinutes);
    await manager.initializeWorkspace();
    manager.startWatching();

    pi.registerTool({
      name: "diagnostics",
      label: "Diagnostics",
      description: "Return concise language-server diagnostics for changed files or the workspace.",
      promptSnippet: "Inspect configured language-server diagnostics for changed files or the workspace",
      parameters: diagnosticsParameters,
      async execute(_toolCallId, { scope = "changed" }) {
        if (!manager) throw new Error("LSP is not configured for this session");
        const diagnostics = await manager.diagnostics(scope);
        return { content: [{ type: "text", text: formatDiagnostics(diagnostics) }], details: { diagnostics } };
      },
    });

    pi.registerTool({
      name: "navigation",
      label: "Navigation",
      description: "Find language-server definitions or references. Path and positions are 1-based.",
      promptSnippet: "Find definitions or references through a configured language server",
      parameters: navigationParameters,
      async execute(_toolCallId, { action, path, line, column }, signal) {
        if (!manager) throw new Error("LSP is not configured for this session");
        const locations = await manager.navigate(action, path, line, column, signal);
        const text = locations.length > 0
          ? locations.map((location) => `${location.path}:${location.line}:${location.column}`).join("\n")
          : "No locations found.";
        return { content: [{ type: "text", text }], details: { locations } };
      },
    });
  });

  pi.on("tool_call", async (event) => {
    if (!manager || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const path = event.input.path;
    if (typeof path !== "string" || !manager.match(path)) return;
    await primeLspDiagnostics(manager, path);
  });

  pi.on("tool_result", async (event) => manager ? lspDiagnosticsPatch(manager, event) : undefined);

  pi.on("session_shutdown", async () => {
    await manager?.shutdown();
    manager = undefined;
  });

  return {
    async statuses(cwd) {
      if (manager && manager.cwd === cwd) return manager.statuses();
      const config = await loadConfig();
      if (!config.lsp || config.lsp.servers.length === 0) return [];
      return new LspManager(
        config.lsp.servers,
        cwd,
        undefined,
        config,
        config.lsp.idleTimeoutMinutes,
      ).statuses();
    },
  };
}
