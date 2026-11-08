import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { getEventListeners } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ExtensionEditorComponent, initTheme, type ExtensionToolContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, stripTerminalSequences, type Terminal } from "@earendil-works/pi-tui";
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { theme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { ConfirmationQueue } from "../../execution/confirmation-queue.ts";
import { editCommand } from "./editor.ts";

initTheme("dark", false);

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "timed out waiting for lifecycle marker");
    await delay(5);
  }
}

function fixture(beforeFactory = () => {}, beforeMount = () => {}) {
  const events: string[] = [];
  const terminal: Terminal = {
    start() { events.push("start"); }, stop() { events.push("stop"); },
    async drainInput() {}, write() {}, columns: 80, rows: 24, kittyProtocolActive: false,
    moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {},
    clearScreen() {}, setTitle() {}, setProgress() {},
  };
  const tui = new TuiMainScreen(terminal);
  let editor: (ExtensionEditorComponent & { dispose?(): void }) | undefined;
  let completions = 0;
  const custom: ExtensionUIContext["custom"] = async <T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> => {
    beforeFactory();
    return new Promise<T>((resolve, reject) => {
      const done = (value: unknown): void => {
        events.push("done");
        completions++;
        editor?.dispose?.();
        resolve(value as T);
      };
      // Like Pi, completion before mounting need not call dispose.
      const created = factory(tui, theme, new KeybindingsManager(), done);
      beforeMount();
      Promise.resolve(created).then((component) => {
        assert.ok(component instanceof ExtensionEditorComponent);
        editor = component;
      }).catch(reject);
    });
  };
  // Unused session services deliberately fail instead of masquerading as mocks.
  const ctx = new Proxy({ mode: "tui", ui: { custom } }, {
    get(target, key) {
      assert.ok(key === "mode" || key === "ui", `unexpected context access: ${String(key)}`);
      return Reflect.get(target, key);
    },
  }) as ExtensionToolContext;
  return { ctx, events, tui, get editor() { assert.ok(editor); return editor; }, get completions() { return completions; } };
}

test("editCommand preserves native editing and cleans up cancellation races", async (t) => {
  const cases = ["submit", "cancel", "abort", "pre-aborted", "before-factory", "before-mount", "dispose"] as const;
  for (const action of cases) await t.test(action, async () => {
    const controller = new AbortController();
    const f = fixture(
      () => { if (action === "before-factory") controller.abort(); },
      () => { if (action === "before-mount") controller.abort(); },
    );
    if (action === "pre-aborted") controller.abort();
    const result = editCommand(f.ctx, "echo original", controller.signal);
    await delay(0);
    try {
      if (action === "submit" || action === "cancel" || action === "abort" || action === "dispose") {
        assert.match(stripTerminalSequences(f.editor.render(80).join("\n")), /Edit command/);
        if (action === "submit") f.editor.handleInput("\r");
        if (action === "cancel") f.editor.handleInput("\x1b");
        if (action === "dispose") f.editor.dispose?.();
        if (action === "abort" || action === "dispose") controller.abort();
      }
      assert.equal(getEventListeners(controller.signal, "abort").length, 0, "finish/dispose removes the abort listener, even before mounting");
      if (action === "dispose") {
        assert.equal(f.completions, 0, "disposed editor has no live abort listener");
      } else {
        assert.equal(await result, action === "submit" ? "echo original" : undefined);
        controller.abort();
        assert.equal(f.completions, action === "pre-aborted" ? 0 : 1);
      }
    } finally {
      f.tui.stop();
    }
  });
});

test("editCommand rejects RPC with the original error", async () => {
  const f = fixture();
  const ctx = { ...f.ctx, mode: "rpc" } as ExtensionToolContext;
  await assert.rejects(editCommand(ctx, "echo original", new AbortController().signal), {
    message: "Editing commands requires terminal UI. Request a revised command instead.",
  });
  assert.equal(f.completions, 0);
});

test("native Ctrl+G retains terminal ownership through actual child exit and restart", async (t) => {
  for (const action of ["submit", "abort", "session-reset"] as const) await t.test(action, async () => {
    const directory = mkdtempSync(join(tmpdir(), "gear-editor-test-"));
    const script = join(directory, "editor.cjs");
    const ready = join(directory, "ready");
    const gate = join(directory, "gate");
    const exited = join(directory, "exited");
    writeFileSync(script, `
const fs = require('node:fs');
const path = require('node:path');
const dir = __dirname;
fs.writeFileSync(path.join(dir, 'ready'), fs.readFileSync(process.argv[2]));
const timer = setInterval(() => {
  if (!fs.existsSync(path.join(dir, 'gate'))) return;
  clearInterval(timer);
  fs.writeFileSync(process.argv[2], 'echo revised\\n');
  fs.writeFileSync(path.join(dir, 'exited'), 'yes');
}, 5);
setTimeout(() => process.exit(2), 10000).unref();
`);
    const visual = process.env.VISUAL;
    process.env.VISUAL = `${process.execPath} ${script}`;
    const controller = new AbortController();
    const queue = new ConfirmationQueue();
    const f = fixture();
    let helperSettled = false;
    let executionCount = 0;
    let helper: Promise<string | undefined> | undefined;
    const execution = queue.confirm(async (signal) => {
      helper = editCommand(f.ctx, "echo original", signal);
      const edited = await helper;
      helperSettled = true;
      if (signal.aborted || edited === undefined) return false;
      executionCount++;
      return true;
    }, controller.signal);
    try {
      await until(() => helper !== undefined);
      f.editor.handleInput("\x07");
      await until(() => existsSync(ready));
      assert.equal(readFileSync(ready, "utf8"), "echo original");
      assert.deepEqual(f.events, ["stop"]);

      if (action === "abort") controller.abort();
      if (action === "session-reset") queue.reset();
      let nextOpened = false;
      const next = queue.confirm(async () => { nextOpened = true; return true; });
      if (action !== "submit") assert.equal(await execution, false, "outer cancellation resolves promptly");
      await delay(0);
      assert.equal(helperSettled, false);
      assert.equal(f.completions, 0);
      assert.equal(nextOpened, false, "queue still owns the editor callback");
      assert.equal(existsSync(exited), false);
      assert.deepEqual(f.events, ["stop"], "no UI completion or restart while child owns terminal");

      writeFileSync(gate, "release");
      await until(() => f.events.includes("start"));
      assert.equal(existsSync(exited), true);
      if (action === "submit") {
        assert.equal(helperSettled, false, "external return does not submit");
        f.editor.handleInput("\r");
      }
      assert.equal(await helper, action === "submit" ? "echo revised" : undefined);
      assert.equal(await execution, action === "submit");
      assert.equal(await next, true);
      assert.deepEqual(f.events.slice(0, 3), ["stop", "start", "done"]);
      f.editor.handleInput("\r");
      assert.equal(f.completions, 1, "late submission cannot complete again");
      assert.equal(executionCount, action === "submit" ? 1 : 0, "cancelled command never executes");
    } finally {
      try {
        writeFileSync(gate, "release");
        if (f.events.includes("stop")) await until(() => f.events.includes("start"));
      } finally {
        f.editor.dispose?.();
        f.tui.stop();
        if (visual === undefined) delete process.env.VISUAL;
        else process.env.VISUAL = visual;
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });
});
