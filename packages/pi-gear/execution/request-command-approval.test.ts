import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  ExtensionEditorComponent,
  initTheme,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ExtensionUIContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Editor as NativeEditor, KeybindingsManager, type TUI } from "@earendil-works/pi-tui";
import { CONFIRMATION_TIMEOUT_MS, ConfirmationQueue } from "./confirmation-queue.ts";
import { setupRequestCommand, type CommandDetails, type requestCommandParameters } from "./request-command.ts";

initTheme();

const longCommand = Array.from({ length: 100 }, (_, i) => `printf 'review line ${i}\\n'`).join("\n");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
type Editor = ExtensionEditorComponent & { dispose?(): void };

function fixture(confirmationQueue?: ConfirmationQueue) {
  let tool!: ToolDefinition<typeof requestCommandParameters, CommandDetails>;
  const handlers: Record<string, () => void> = {};
  const executed: string[] = [];
  setupRequestCommand({
    on: (event: string, handler: () => void) => { handlers[event] = handler; },
    registerTool: (value: typeof tool) => { tool = value; },
  } as unknown as ExtensionAPI, {
    ...(confirmationQueue ? { confirmationQueue } : {}),
    createBashTool: (() => ({
      execute: async (_id: string, input: { command: string }) => {
        executed.push(input.command);
        return { content: [], details: undefined };
      },
    })) as never,
  });
  return { tool, handlers, executed };
}

function context(ui: Partial<ExtensionUIContext>, mode = "tui"): ExtensionToolContext {
  return { cwd: process.cwd(), hasUI: true, mode, ui } as unknown as ExtensionToolContext;
}

// Like Pi, dispose only after the factory has returned and the component has mounted.
function editorUI(
  onOpen: (editor: Editor, submit: (value: string | undefined) => void) => void,
  beforeMount?: () => void,
  terminal: Pick<TUI, "requestRender" | "stop" | "start"> = {
    requestRender() {}, stop() { assert.fail("external editor unexpectedly opened"); }, start() {},
  },
) {
  let opens = 0;
  let disposals = 0;
  let completions = 0;
  const custom: ExtensionUIContext["custom"] = async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0], options?: unknown): Promise<T> => {
    assert.equal(options, undefined, "Edit uses the SDK editor, not a custom overlay");
    opens++;
    return new Promise<T>((resolve, reject) => {
      let component: Editor | undefined;
      let completed = false;
      let value: T;
      const finish = () => {
        if (!component || !completed) return;
        component.dispose?.();
        disposals++;
        resolve(value);
      };
      const done = (result: unknown) => {
        if (completed) return;
        completions++;
        completed = true;
        value = result as T;
        finish();
      };
      const created = factory(
        terminal as unknown as Parameters<typeof factory>[0],
        {} as Parameters<typeof factory>[1],
        new KeybindingsManager({
          "app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
        }) as unknown as Parameters<typeof factory>[2], done,
      );
      beforeMount?.();
      Promise.resolve(created).then((mounted) => {
        assert.ok(mounted instanceof ExtensionEditorComponent);
        component = mounted;
        if (completed) finish();
        else onOpen(component, done);
      }).catch(reject);
    });
  };
  return { custom, get opens() { return opens; }, get disposals() { return disposals; }, get completions() { return completions; } };
}

function checkSelector(title: string, choices: string[], options?: Parameters<ExtensionUIContext["select"]>[2]) {
  assert.deepEqual(choices, ["Run", "Edit", "Cancel"]);
  assert.ok(options?.timeout !== undefined && options.timeout > 0 && options.timeout <= CONFIRMATION_TIMEOUT_MS);
  assert.ok(options?.signal instanceof AbortSignal);
  assert.equal(options.signal.aborted, false);
  assert.ok(title.length < 500, "native selector title stays compact");
  assert.ok(!title.includes(longCommand), "full command belongs in the editor");
}

function nativeEditor(component: Editor): NativeEditor {
  const editor = component.children.find((child) => child instanceof NativeEditor);
  assert.ok(editor instanceof NativeEditor);
  return editor;
}

function terminalDimensions(t: TestContext, initialColumns = 120, initialRows = 24) {
  const descriptors = ["columns", "rows"].map((key) => [key, Object.getOwnPropertyDescriptor(process.stdout, key)] as const);
  t.after(() => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(process.stdout, key, descriptor);
      else Reflect.deleteProperty(process.stdout, key);
    }
  });
  const dimensions = { columns: initialColumns, rows: initialRows };
  Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => dimensions.columns });
  Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => dimensions.rows });
  return dimensions;
}

const commands = [
  { name: "short", command: "  printf short  " },
  { name: "huge single line", command: `printf '${"x".repeat(100_000)}'` },
  { name: "long multiline", command: longCommand },
];

test("native Run executes exact full input; Cancel and undefined deny without opening an editor", async (t) => {
  terminalDimensions(t);
  for (const row of commands) {
    for (const choice of ["Run", "Cancel", undefined]) {
      await t.test(`${row.name}: ${choice}`, async () => {
        const { tool, executed } = fixture();
        let selections = 0;
        const result = await tool.execute("native", { command: row.command }, undefined, undefined, context({
          select: async (title, choices, options) => {
            selections++;
            checkSelector(title, choices, options);
            assert.ok(title.includes("$ "));
            if (row.name !== "short") {
              assert.ok(!title.includes(row.command), "long commands are previews, not full selector titles");
              assert.match(title, /Edit/);
              assert.ok(title.includes(row.name === "long multiline" ? "review line 0" : "$ printf"));
            }
            return choice;
          },
          custom: async () => assert.fail("native selection must not automatically open custom UI"),
        }));
        assert.equal(selections, 1);
        assert.equal(result.details?.status, choice === "Run" ? "Completed" : "Cancelled", JSON.stringify(result.content));
        assert.deepEqual(executed, choice === "Run" ? [row.command] : []);
      });
    }
  }
});

test("optional Edit opens the full command in the SDK editor and submits without another selector", async (t) => {
  terminalDimensions(t);
  for (const command of ["printf original", commands[1]!.command, longCommand]) {
    for (const action of ["unchanged", "edited", "escape", "undefined", "blank"]) {
      await t.test(`${command.length} bytes: ${action}`, async () => {
        const { tool, executed } = fixture();
        let selections = 0;
        const editor = editorUI((component, submit) => {
          assert.equal(selections, 1, "selector precedes optional editor");
          assert.equal(nativeEditor(component).getText(), command, "SDK receives all of the original command");
          if (action === "undefined") return submit(undefined);
          if (action === "escape") return component.handleInput("\x1b");
          if (action === "edited") nativeEditor(component).setText("  printf revised  ");
          if (action === "blank") nativeEditor(component).setText(" \n ");
          component.handleInput("\r");
        });
        const result = await tool.execute("edit", { command }, undefined, undefined, context({
          custom: editor.custom,
          select: async (title, choices, options) => {
            selections++;
            assert.equal(selections, 1, "submitting Edit must not reopen approval");
            assert.equal(editor.opens, 0);
            checkSelector(title, choices, options);
            return "Edit";
          },
        }));
        const expected = action === "unchanged" ? command : action === "edited" ? "printf revised" : undefined;
        assert.equal(selections, 1);
        assert.equal(editor.opens, 1);
        assert.equal(editor.disposals, 1);
        assert.equal(editor.completions, 1);
        assert.deepEqual(executed, expected === undefined ? [] : [expected]);
        assert.equal(result.details?.status, expected === undefined ? "Cancelled" : "Completed");
      });
    }
  }
});

test("optional native Edit retains the SDK Ctrl+G external-editor path", { timeout: 5000 }, async (t) => {
  terminalDimensions(t);
  const visual = process.env.VISUAL;
  process.env.VISUAL = "/usr/bin/true";
  t.after(() => {
    if (visual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = visual;
  });
  const { tool, executed } = fixture();
  const events: string[] = [];
  let component!: Editor;
  const editor = editorUI((mounted) => {
    component = mounted;
    assert.equal(nativeEditor(component).getText(), longCommand);
    component.handleInput("\u0007");
  }, undefined, {
    stop() { events.push("stop"); },
    start() { events.push("start"); },
    requestRender() {
      assert.deepEqual(events, ["stop", "start"]);
      component.handleInput("\r");
    },
  });
  let selections = 0;
  const result = await tool.execute("external-edit", { command: longCommand }, undefined, undefined, context({
    select: async () => { selections++; assert.equal(selections, 1); return "Edit"; },
    custom: editor.custom,
  }));
  assert.equal(result.details?.status, "Completed", JSON.stringify(result.content));
  assert.deepEqual(events, ["stop", "start"]);
  assert.deepEqual(executed, [longCommand]);
  assert.equal(editor.opens, 1);
  assert.equal(editor.disposals, 1);
});

test("optional Edit is dismissed by caller abort or session lifecycle, including before mount", async (t) => {
  terminalDimensions(t);
  for (const action of ["abort", "session_start", "session_shutdown", "before-mount-abort", "before-mount-session"]) {
    await t.test(action, async () => {
      const { tool, handlers, executed } = fixture();
      const controller = new AbortController();
      let lateSubmit!: (value: string | undefined) => void;
      let selections = 0;
      const editor = editorUI((_component, submit) => { lateSubmit = submit; }, () => {
        if (action === "before-mount-abort") controller.abort();
        if (action === "before-mount-session") handlers.session_start!();
      });
      const pending = tool.execute("cancel-edit", { command: longCommand }, controller.signal, undefined, context({
        custom: editor.custom,
        select: async () => { selections++; assert.equal(selections, 1); return "Edit"; },
      }));
      await tick();
      assert.equal(editor.opens, 1);
      const beforeMount = action.startsWith("before-mount");
      assert.equal(editor.disposals, beforeMount ? 1 : 0);
      if (action === "abort") controller.abort();
      else if (!beforeMount) handlers[action]!();
      const result = await pending;
      assert.equal(selections, 1);
      assert.equal(editor.completions, 1);
      assert.equal(editor.disposals, 1);
      assert.equal(result.details?.status, "Cancelled");
      if (!beforeMount) lateSubmit("printf too-late");
      await tick();
      assert.deepEqual(executed, []);
    });
  }
});

test("RPC supports long Run and Cancel, but Edit fails closed without opening terminal UI", async (t) => {
  terminalDimensions(t);
  for (const { name, command } of commands.slice(1)) {
    for (const choice of ["Run", "Cancel", undefined, "Edit"]) {
      await t.test(`${name}: ${choice}`, async () => {
        const { tool, executed } = fixture();
        let selections = 0;
        const result = await tool.execute("rpc", { command }, undefined, undefined, context({
          select: async (title, choices, options) => {
            selections++;
            assert.equal(title, `Run command?\n\n$ ${command}`);
            assert.deepEqual(choices, ["Run", "Edit", "Cancel"]);
            assert.ok(options?.signal);
            assert.ok(options?.timeout && options.timeout > 0);
            return choice;
          },
          custom: async () => assert.fail("RPC opened terminal UI"),
          editor: async () => assert.fail("RPC opened uncancellable editor"),
        }, "rpc"));
        assert.equal(selections, 1);
        assert.equal(result.details?.status, choice === "Run" ? "Completed" : choice === "Edit" ? "Failed" : "Cancelled");
        assert.deepEqual(executed, choice === "Run" ? [command] : []);
        if (choice === "Edit") {
          assert.equal(result.isError, true);
          assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /requires terminal UI/);
        }
      });
    }
  }
});

test("native Edit preserves original bytes when unchanged and rejects normalization-sensitive edits", async (t) => {
  terminalDimensions(t);
  for (const row of [
    { name: "tab-indented heredoc unchanged", command: `${longCommand}\ncat <<-EOF\n\tvalue\n\tEOF`, edit: false },
    { name: "CRLF unchanged", command: longCommand.replace(/\n/g, "\r\n"), edit: false },
    { name: "bare CR unchanged", command: "printf one\rprintf two", edit: false },
    { name: "outer whitespace unchanged", command: `  ${longCommand}\n\n`, edit: false },
    { name: "normalized tabs cannot silently change on edit", command: `${longCommand}\nprintf '\t'`, edit: true },
    { name: "normalized CRLF cannot silently change on edit", command: longCommand.replace(/\n/g, "\r\n"), edit: true },
    { name: "normalized bare CR cannot silently change on edit", command: "printf one\rprintf two", edit: true },
  ]) await t.test(row.name, async () => {
    const { tool, executed } = fixture();
    let selections = 0;
    const editor = editorUI((component) => {
      assert.equal(nativeEditor(component).getText(), row.command.replace(/\r\n?/g, "\n").replace(/\t/g, "    "));
      if (row.edit) nativeEditor(component).setText("printf revised");
      component.handleInput("\r");
    });
    const result = await tool.execute("bytes", { command: row.command }, undefined, undefined, context({
      custom: editor.custom,
      select: async () => { selections++; assert.equal(selections, 1); return "Edit"; },
    }));
    assert.equal(editor.opens, 1);
    assert.equal(editor.disposals, 1);
    assert.equal(selections, 1);
    assert.deepEqual(executed, row.edit ? [] : [row.command]);
    assert.equal(result.details?.status, row.edit ? "Failed" : "Completed");
    if (row.edit) assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /normalizes tabs and carriage returns/);
  });
});

test("queued native approval recomputes its preview after terminal dimensions shrink", async (t) => {
  const dimensions = terminalDimensions(t, 1000, 60);
  const queue = new ConfirmationQueue();
  let release!: (approved: boolean) => void;
  const blocker = queue.confirm(() => new Promise<boolean>((resolve) => { release = resolve; }));
  t.after(() => release?.(false));
  await tick();
  const { tool, executed } = fixture(queue);
  const command = `printf '${"x".repeat(800)}'`;
  let selections = 0;
  const pending = tool.execute("resized", { command }, undefined, undefined, context({
    custom: async () => assert.fail("shrinking dimensions must not force an editor"),
    select: async (title, choices, options) => {
      selections++;
      checkSelector(title, choices, options);
      assert.ok(title.includes("$ printf"), "shrunk preview still shows the command prefix");
      assert.ok(!title.includes(command), "preview uses shrunk dimensions, not dimensions at enqueue time");
      assert.match(title, /Edit/);
      assert.ok(title.length < 300, "40x24 preview stays within the smaller screen budget");
      return "Run";
    },
  }));
  await tick();
  assert.equal(selections, 0, "approval waits behind the queue blocker");
  dimensions.columns = 40;
  dimensions.rows = 24;
  release(true);
  await blocker;
  const result = await pending;
  assert.equal(selections, 1);
  assert.equal(result.details?.status, "Completed", JSON.stringify(result.content));
  assert.deepEqual(executed, [command]);
});
