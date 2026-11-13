import assert from "node:assert/strict";
import test from "node:test";
import { ExtensionSelectorComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { commandApprovalPrompt } from "./approval.ts";

initTheme("dark", false);

function nativeHeight(title: string, columns: number, suffix = " (30s)"): number {
  return new ExtensionSelectorComponent(
    title + suffix, ["Run", "Edit", "Cancel"], () => {}, () => {},
  ).render(columns).length;
}

interface PromptCase {
  name: string;
  command: string;
  reason?: string;
  directory?: string;
  columns?: number;
  rows?: number;
  title?: string;
  preview?: string;
  tiny?: boolean;
  customKeys?: boolean;
  countdownBoundary?: boolean;
  linePrefixes?: string[];
  boundedInput?: boolean;
}

const cases: PromptCase[] = [
  {
    name: "default 24x80 prioritizes one command preview and the full-view hint",
    command: "x".repeat(1000), reason: "Check output", directory: "/tmp",
    title: `$ ${"x".repeat(76)}\n… Edit: full command`, preview: "$ xxx",
  },
  {
    name: "multi-megabyte input is bounded before native rendering",
    command: "x".repeat(5_000_000), columns: 80, rows: 24, preview: "$ xxx", boundedInput: true,
  },
  {
    name: "long unbroken line counts wrapped cells, not newlines",
    command: "COMMAND_BODY".repeat(200), columns: 80, rows: 24, preview: "$ COMMAND_BODY",
  },
  {
    name: "multiline command keeps its first lines within the native budget",
    command: Array.from({ length: 40 }, (_, i) => `echo BODY_${i}`).join("\n"),
    columns: 80, rows: 28, preview: "$ echo BODY_0\necho BODY_1\necho BODY_2",
  },
  {
    name: "wide Unicode and combining marks are measured in visual cells",
    command: "界🙂é".repeat(100), columns: 80, rows: 24, preview: "$ 界🙂é",
  },
  {
    name: "long reason and cwd cannot displace the command preview",
    command: "echo COMMAND_BODY", reason: "r".repeat(1000), directory: "/" + "d".repeat(1000),
    columns: 80, rows: 24, title: "$ echo COMMAND_BODY\n… Edit: full command", preview: "$ echo COMMAND_BODY",
  },
  {
    name: "metadata is bounded when compact mode has spare room",
    command: "true", reason: "reason".repeat(100), directory: "/" + "dir".repeat(100),
    columns: 80, rows: 30, preview: "$ true",
    linePrefixes: ["Run command?", "reason", "/dir", "$ true", "… Edit"],
  },
  {
    name: "narrower terminal includes wrapped native key hints",
    command: "x".repeat(1000), columns: 40, rows: 24, preview: "$ xxx",
  },
  {
    name: "one title row combines preview and explicit hint",
    command: "x".repeat(1000), columns: 80, rows: 22, preview: "$ xxx",
  },
  {
    name: "larger terminal preserves the entire original short title",
    command: "echo 界🙂é", reason: "Check output", directory: "/tmp", columns: 80, rows: 40,
    title: "Run command?\n\nCheck output\n\n/tmp\n$ echo 界🙂é",
  },
  {
    name: "absent metadata retains original spacing when it fits",
    command: "true", columns: 80, rows: 40, title: "Run command?\n\n$ true",
  },
  {
    name: "empty metadata adds no sections",
    command: "true", reason: "", directory: "", columns: 80, rows: 40,
    title: "Run command?\n\n$ true",
  },
  {
    name: "dimension changes can fit an otherwise oversized command unchanged",
    command: "x".repeat(500), columns: 1000, rows: 40,
    title: `Run command?\n\n$ ${"x".repeat(500)}`,
  },
  {
    name: "countdown suffix on last title line prevents a false full-title fit",
    command: "x".repeat(76), columns: 80, rows: 26, preview: "$ xxx", countdownBoundary: true,
  },
  {
    name: "current native keybinding hint wraps are measured",
    command: "x".repeat(1000), columns: 50, rows: 32, preview: "$ xxx", customKeys: true,
  },
  {
    name: "full display sanitizes ANSI OSC C0 C1 without changing source strings",
    command: "echo\t\x1b[31mhello\x1b[0m\x00\x9b", reason: "\x1b]0;unsafe\x07Safe\r\nreason",
    directory: "/tmp\x7f", columns: 80, rows: 60,
    title: "Run command?\n\nSafe\nreason\n\n/tmp\n$ echo   hello",
  },
  {
    name: "compact display sanitizes command and metadata too",
    command: "\x1b[31mecho\x1b[0m\tBODY\x00\x9b".repeat(100),
    reason: "\x1b]0;unsafe\x07reason".repeat(100), directory: "/tmp\x7f".repeat(100),
    columns: 80, rows: 24, preview: "$ echo   BODY",
  },
  {
    name: "native minimum already exceeds half of a short terminal",
    command: "COMMAND_BODY", columns: 80, rows: 20, preview: "$ COMMAND_BODY", tiny: true,
  },
  {
    name: "narrow native minimum is best effort rather than a strict half claim",
    command: "COMMAND_BODY", columns: 14, rows: 24, preview: "$", tiny: true,
  },
  {
    name: "zero dimensions use best-effort native minimum without throwing",
    command: "COMMAND_BODY", columns: 0, rows: 0, preview: "$", tiny: true,
  },
];

test("commandApprovalPrompt formats titles for the actual native selector", async (t) => {
  for (const row of cases) await t.test(row.name, () => {
    const bindings = getKeybindings();
    const saved = bindings.getUserBindings();
    try {
      if (row.customKeys) bindings.setUserBindings({
        ...saved, "tui.select.confirm": "ctrl+shift+enter", "tui.select.cancel": "ctrl+shift+escape",
      });
      const columns = Math.max(1, row.columns ?? process.stdout.columns ?? 80);
      const rows = row.rows ?? process.stdout.rows ?? 24;
      const input = [row.command, row.reason, row.directory];
      let maxMeasuredRows = 0;
      if (row.boundedInput) {
        const render = ExtensionSelectorComponent.prototype.render;
        t.mock.method(ExtensionSelectorComponent.prototype, "render", function (this: ExtensionSelectorComponent, width: number) {
          const lines = render.call(this, width);
          maxMeasuredRows = Math.max(maxMeasuredRows, lines.length);
          return lines;
        });
      }
      const result = commandApprovalPrompt(row.command, row.reason, row.directory, row.columns, row.rows);

      if (row.boundedInput) assert.ok(maxMeasuredRows <= rows * 2, "native renderer never sees the discarded tail");
      assert.deepEqual(Object.keys(result), ["title"], "API has no forced-review flag");
      assert.deepEqual([row.command, row.reason, row.directory], input);
      assert.equal(result.title, stripTerminalSequences(result.title));
      assert.doesNotMatch(result.title, /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
      if (row.title !== undefined) assert.equal(result.title, row.title);
      if (row.linePrefixes) {
        const lines = result.title.split("\n");
        assert.equal(lines.length, row.linePrefixes.length);
        row.linePrefixes.forEach((prefix, index) => assert.ok(lines[index]!.startsWith(prefix)));
      }
      if (row.preview) {
        assert.ok(result.title.includes(row.preview), "command remains visible");
        assert.ok(result.title.includes("… Edit: full command"), "truncation explicitly offers Edit");
      }

      const height = nativeHeight(result.title, columns);
      if (row.tiny) {
        assert.ok(nativeHeight("$", columns) > Math.floor(rows / 2), "native minimum itself cannot fit half");
        assert.equal(result.title.split("\n").length, 1, "best effort uses a single logical title line");
      } else {
        assert.ok(height <= Math.floor(rows / 2), `${height} native rows exceed half of ${rows}`);
        for (const line of result.title.split("\n")) assert.ok(visibleWidth(line) <= columns);
      }
      if (row.countdownBoundary) {
        const original = `Run command?\n\n$ ${row.command}`;
        assert.ok(nativeHeight(original, columns, "") <= Math.floor(rows / 2));
        assert.ok(nativeHeight(original, columns) > Math.floor(rows / 2));
        assert.notEqual(result.title, original);
      }
      if (row.customKeys) {
        const customized = nativeHeight("$", columns);
        bindings.setUserBindings(saved);
        assert.ok(customized > nativeHeight("$", columns), "custom keys really wrap the SDK hint");
      }
    } finally {
      bindings.setUserBindings(saved);
    }
  });
});
