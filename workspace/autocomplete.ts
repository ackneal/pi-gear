import { basename } from "node:path";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  AutocompleteSuggestions,
} from "@earendil-works/pi-tui";
import type { WorkspaceSearch } from "./service.ts";

const atPrefix = (text: string): string | undefined =>
  text.match(/(?:^|[\s='"])(@[^\s]*)$/)?.[1];

export class WorkspaceAutocompleteProvider implements AutocompleteProvider {
  readonly triggerCharacters = ["@"];
  private readonly selections = new Map<string, { query: string; path: string }>();
  private suggestionGeneration = 0;
  private readonly current: AutocompleteProvider;
  private readonly search: WorkspaceSearch;

  constructor(current: AutocompleteProvider, search: WorkspaceSearch) {
    this.current = current;
    this.search = search;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null> {
    const generation = ++this.suggestionGeneration;
    this.selections.clear();
    const line = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const prefix = atPrefix(line);
    if (!prefix) {
      return this.current.getSuggestions(lines, cursorLine, cursorCol, options);
    }

    try {
      if (options.signal.aborted) return null;

      const query = prefix.slice(1);
      const result = await this.search.mixedSearch(query, { pageSize: 50 });
      if (options.signal.aborted) return null;

      const items: AutocompleteItem[] = result.items.slice(0, 20).map((entry) => {
        const path = entry.item.relativePath;
        const directory = entry.type === "directory";
        const displayPath = `${path}${directory && !path.endsWith("/") ? "/" : ""}`;
        const label = `${basename(path)}${directory ? "/" : ""}`;
        const value = `@${displayPath.includes(" ") ? `"${displayPath}"` : displayPath}`;
        if (generation === this.suggestionGeneration) {
          this.selections.set(value, { query, path });
        }
        return { value, label, description: displayPath };
      });

      if (items.length) return { items, prefix };
      return this.current.getSuggestions(lines, cursorLine, cursorCol, options);
    } catch {
      if (options.signal.aborted) return null;
      return this.current.getSuggestions(lines, cursorLine, cursorCol, options);
    }
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ) {
    const selected = this.selections.get(item.value);
    if (selected && !item.label.endsWith("/")) {
      void this.search.trackQuery(selected.query, selected.path);
    }
    return this.current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
  }

  shouldTriggerFileCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    return this.current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
  }
}
