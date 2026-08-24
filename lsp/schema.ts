import type { LspDiagnostic, LspPosition, LspRange, SourceLocationResponse } from "./types.ts";

/** Protocol subset implemented by pi-gear. See https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/ */
export const SUPPORTED_LSP_VERSION = "3.17";

const invalid = (path: string, expected: string): never => {
  throw new Error(`Invalid LSP ${SUPPORTED_LSP_VERSION} payload: ${path} must be ${expected}`);
};

const record = (value: unknown, path: string): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : invalid(path, "an object");

const string = (value: unknown, path: string): string =>
  typeof value === "string" ? value : invalid(path, "a string");

const integer = (value: unknown, path: string): number =>
  Number.isInteger(value) && (value as number) >= -2_147_483_648 && (value as number) <= 2_147_483_647
    ? value as number
    : invalid(path, "a signed 32-bit integer");

const uinteger = (value: unknown, path: string): number =>
  Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 2_147_483_647
    ? value as number
    : invalid(path, "an unsigned 32-bit integer");

const position = (value: unknown, path: string): LspPosition => {
  const input = record(value, path);
  return {
    line: uinteger(input.line, `${path}.line`),
    character: uinteger(input.character, `${path}.character`),
  };
};

const range = (value: unknown, path: string): LspRange => {
  const input = record(value, path);
  return {
    start: position(input.start, `${path}.start`),
    end: position(input.end, `${path}.end`),
  };
};

const diagnostic = (value: unknown, path: string): LspDiagnostic => {
  const input = record(value, path);
  const severity = input.severity;
  if (severity !== undefined && severity !== 1 && severity !== 2 && severity !== 3 && severity !== 4) {
    invalid(`${path}.severity`, "one of 1, 2, 3, or 4");
  }
  const parsedSeverity = severity as 1 | 2 | 3 | 4 | undefined;
  const code = input.code;
  if (code !== undefined && typeof code !== "string") integer(code, `${path}.code`);

  return {
    range: range(input.range, `${path}.range`),
    message: string(input.message, `${path}.message`),
    ...(parsedSeverity === undefined ? {} : { severity: parsedSeverity }),
    ...(code === undefined ? {} : { code: code as string | number }),
    ...(input.source === undefined ? {} : { source: string(input.source, `${path}.source`) }),
  };
};

export const parsePublishDiagnostics = (value: unknown): { uri: string; diagnostics: LspDiagnostic[] } => {
  const input = record(value, "publishDiagnostics.params");
  if (input.version !== undefined) integer(input.version, "publishDiagnostics.params.version");
  const diagnostics = input.diagnostics;
  if (!Array.isArray(diagnostics)) invalid("publishDiagnostics.params.diagnostics", "an array");
  const entries = diagnostics as unknown[];
  return {
    uri: string(input.uri, "publishDiagnostics.params.uri"),
    diagnostics: entries.map((value, index) => diagnostic(value, `publishDiagnostics.params.diagnostics[${index}]`)),
  };
};

const location = (value: unknown, path: string): SourceLocationResponse => {
  const input = record(value, path);
  return { uri: string(input.uri, `${path}.uri`), range: range(input.range, `${path}.range`) };
};

const locationLink = (value: unknown, path: string): SourceLocationResponse => {
  const input = record(value, path);
  return {
    targetUri: string(input.targetUri, `${path}.targetUri`),
    targetRange: range(input.targetRange, `${path}.targetRange`),
    targetSelectionRange: range(input.targetSelectionRange, `${path}.targetSelectionRange`),
  };
};

export const parseNavigationResponse = (
  action: "definition" | "references",
  value: unknown,
): SourceLocationResponse[] => {
  if (value === null) return [];
  if (value === undefined) invalid(`${action}.result`, "a valid LSP result or null");
  if (action === "references") {
    if (!Array.isArray(value)) invalid("references.result", "an array of Location objects or null");
    const locations = value as unknown[];
    return locations.map((entry, index) => location(entry, `references.result[${index}]`));
  }
  if (!Array.isArray(value)) return [location(value, "definition.result")];
  if (value.length === 0) return [];

  const first = record(value[0], "definition.result[0]");
  return first.targetUri === undefined
    ? value.map((entry, index) => location(entry, `definition.result[${index}]`))
    : value.map((entry, index) => locationLink(entry, `definition.result[${index}]`));
};
