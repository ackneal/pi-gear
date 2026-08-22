const INTERNAL_ID = /\b(?:call|toolu|tool|msg|run)_[A-Za-z0-9_-]+\b|\b[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\b|\b[0-9a-f]{24,}\b/gi;
const JSON_FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/i;
const USEFUL_JSON_KEYS = new Set(["text", "content", "result", "output", "message", "detail", "details", "summary", "answer", "title", "snippet", "description"]);

export function readableProvider(name: string): string {
  const normalized = name.toLowerCase();
  if (/(?:^|__|[_-])exa(?:__|[_-]|$)/.test(normalized)) return "Exa";
  if (/(?:^|__|[_-])context7(?:__|[_-]|$)/.test(normalized)) return "Context7";
  if (/(?:^|__|[_-])gh_grep(?:__|[_-]|$)|(?:^|__|[_-])searchgithub(?:__|[_-]|$)/.test(normalized)) return "GitHub grep";
  const parts = name.split(/__|::|\//).filter(Boolean);
  const provider = (parts.length > 1 && /^mcp$/i.test(parts[0] ?? "") ? parts[1] : parts[0]) ?? name;
  return provider.replace(/^(?:mcp|tool)[_-]*/i, "").replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase()) || "Tool";
}

export function cleanPlainText(value: string): string {
  return value.replace(INTERNAL_ID, "").replace(/^\s*thinking:\s*/i, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();
}

function stringsFromJson(value: unknown, collected: string[] = []): string[] {
  if (typeof value === "string") {
    const text = cleanPlainText(value);
    if (text) collected.push(text);
    return collected;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringsFromJson(entry, collected);
    return collected;
  }
  if (typeof value !== "object" || value === null) return collected;
  for (const [key, entry] of Object.entries(value)) if (USEFUL_JSON_KEYS.has(key.toLowerCase())) stringsFromJson(entry, collected);
  return collected;
}

export function usefulText(value: string | undefined): string {
  if (!value) return "";
  const candidate = value.trim().match(JSON_FENCE)?.[1] ?? value.trim();
  if (/^[{[]/.test(candidate)) {
    try { return [...new Set(stringsFromJson(JSON.parse(candidate)))].join("\n"); } catch { return ""; }
  }
  return cleanPlainText(value);
}
