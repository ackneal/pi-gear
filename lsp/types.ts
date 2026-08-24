export interface LspPosition {
  readonly line: number;
  readonly character: number;
}

export interface LspRange {
  readonly start: LspPosition;
  readonly end: LspPosition;
}

export interface LspDiagnostic {
  readonly range: LspRange;
  readonly severity?: number;
  readonly code?: string | number;
  readonly source?: string;
  readonly message: string;
}

export interface NormalizedDiagnostic {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning";
  readonly message: string;
  readonly code?: string;
}

export type SourceLocationResponse =
  | { readonly uri: string; readonly range: LspRange }
  | { readonly targetUri: string; readonly targetRange: LspRange; readonly targetSelectionRange: LspRange };

export interface SourceLocation {
  readonly path: string;
  readonly line: number;
  readonly column: number;
}
