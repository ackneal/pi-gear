import { ExtensionSelectorComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

function displayText(text: string, maxChars: number): string {
  return stripTerminalSequences(text.slice(0, maxChars).replace(/[\uD800-\uDBFF]$/, ""))
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "   ")
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, "");
}

export function commandApprovalPrompt(
  command: string,
  reason: string | undefined,
  directory: string | undefined,
  columns = process.stdout.columns ?? 80,
  rows = process.stdout.rows ?? 24,
): { title: string } {
  columns = Math.max(1, columns);
  const width = Math.max(1, columns - 2 * Math.min(1, Math.floor((columns - 1) / 2)));
  const budget = Math.floor(rows / 2);
  const suffix = " (30s)";
  const height = (title: string): number => new ExtensionSelectorComponent(
    title + suffix, ["Run", "Edit", "Cancel"], () => {}, () => {},
  ).render(columns).length;

  // Bound work before wrapping: discarded command tails must not block the UI.
  const maxChars = columns * Math.max(1, budget);
  const complete = [command, reason, directory].every((text) => !text || text.length <= maxChars);
  const safeCommand = displayText(command, maxChars);
  const safeReason = reason && displayText(reason, maxChars);
  const safeDirectory = directory && displayText(directory, maxChars);
  const original = ["Run command?", safeReason, [safeDirectory, `$ ${safeCommand}`].filter(Boolean).join("\n")]
    .filter(Boolean).join("\n\n");
  if (complete && height(original) <= budget) return { title: original };

  const hint = "… Edit: full command";
  // Wrap the command before adding the shell prefix: native word wrapping
  // otherwise puts "$" alone on the first row of a long unbroken command.
  const preview = wrapTextWithAnsi(safeCommand, Math.max(1, width - 2));
  preview[0] = `$ ${preview[0]}`;
  let title = `${preview[0]}\n${hint}`;
  if (height(title) <= budget) {
    let low = 1;
    let high = Math.min(preview.length, Math.max(1, budget));
    while (low < high) {
      const count = Math.ceil((low + high) / 2);
      if (height(`${preview.slice(0, count).join("\n")}\n${hint}`) <= budget) low = count;
      else high = count - 1;
    }
    title = `${preview.slice(0, low).join("\n")}\n${hint}`;
  } else {
    // Native chrome and the explicit hint have a minimum height. On physically
    // tiny terminals this best-effort single-line preview can exceed half-height.
    const space = Math.max(1, width - visibleWidth(hint + suffix) - 1);
    title = `${stripTerminalSequences(truncateToWidth(preview[0], space, ""))} ${hint}`;
  }

  const metadataLines: string[] = [];
  for (const metadata of ["Run command?", safeReason, safeDirectory]) {
    if (!metadata) continue;
    const line = stripTerminalSequences(truncateToWidth(metadata.replace(/\n/g, " "), width, "…"));
    if (height([...metadataLines, line, title].join("\n")) <= budget) metadataLines.push(line);
  }
  return { title: [...metadataLines, title].join("\n") };
}
