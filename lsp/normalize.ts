import { relative } from "node:path";
import type { LspDiagnostic, NormalizedDiagnostic } from "./types.ts";

export function normalizeDiagnostics(
  path: string,
  cwd: string,
  diagnostics: readonly LspDiagnostic[],
): NormalizedDiagnostic[] {
  return diagnostics.flatMap((diagnostic) => {
    const severity = diagnostic.severity === 1 ? "error" : diagnostic.severity === 2 ? "warning" : undefined;
    if (!severity || typeof diagnostic.message !== "string") return [];

    return [{
      path: relative(cwd, path) || ".",
      line: diagnostic.range.start.line + 1,
      column: diagnostic.range.start.character + 1,
      severity,
      message: diagnostic.message.replace(/\s+/g, " ").trim(),
      ...(diagnostic.code === undefined ? {} : { code: String(diagnostic.code) }),
    }];
  });
}

export function formatDiagnostics(diagnostics: readonly NormalizedDiagnostic[]): string {
  if (diagnostics.length === 0) return "No errors or warnings.";
  return diagnostics.map((diagnostic) => {
    const code = diagnostic.code ? ` [${diagnostic.code}]` : "";
    return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column} ${diagnostic.severity}${code}: ${diagnostic.message}`;
  }).join("\n");
}

export function diagnosticKey(diagnostic: NormalizedDiagnostic): string {
  return `${diagnostic.path}:${diagnostic.line}:${diagnostic.column}:${diagnostic.code ?? ""}:${diagnostic.message}`;
}
