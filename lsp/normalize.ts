import { relative } from "node:path";
import type { DiagnosticSeverity, LspDiagnostic, NormalizedDiagnostic } from "./types.ts";

const severityName = (severity: number | undefined): DiagnosticSeverity => {
  if (severity === 2) return "warning";
  if (severity === 3) return "information";
  if (severity === 4) return "hint";
  return "error";
};

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  error: 0,
  warning: 1,
  information: 2,
  hint: 3,
};

export function normalizeDiagnostics(
  path: string,
  cwd: string,
  diagnostics: readonly LspDiagnostic[],
): NormalizedDiagnostic[] {
  return diagnostics.map((diagnostic) => ({
    path: relative(cwd, path) || ".",
    line: diagnostic.range.start.line + 1,
    column: diagnostic.range.start.character + 1,
    endLine: diagnostic.range.end.line + 1,
    endColumn: diagnostic.range.end.character + 1,
    severity: severityName(diagnostic.severity),
    message: diagnostic.message.replace(/\s+/g, " ").trim(),
    ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
    ...(diagnostic.source === undefined ? {} : { source: diagnostic.source }),
  }));
}

export function formatDiagnostics(diagnostics: readonly NormalizedDiagnostic[]): string {
  if (diagnostics.length === 0) return "No diagnostics.";
  return diagnostics.map((diagnostic) => {
    const source = diagnostic.source ? ` ${diagnostic.source}` : "";
    const code = diagnostic.code ? ` ${diagnostic.code}` : "";
    return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} [${diagnostic.severity}]${source}${code}\n${diagnostic.message}`;
  }).join("\n");
}

export function diagnosticKey(diagnostic: NormalizedDiagnostic): string {
  return JSON.stringify([
    diagnostic.path,
    diagnostic.line,
    diagnostic.column,
    diagnostic.endLine,
    diagnostic.endColumn,
    diagnostic.severity,
    diagnostic.code ?? "",
    diagnostic.source ?? "",
    diagnostic.message,
  ]);
}

export function deduplicateAndOrderDiagnostics(
  diagnostics: readonly NormalizedDiagnostic[],
): NormalizedDiagnostic[] {
  const unique = new Map<string, NormalizedDiagnostic>();
  for (const diagnostic of diagnostics) unique.set(diagnosticKey(diagnostic), diagnostic);
  return [...unique.values()].sort((left, right) => SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity]);
}
