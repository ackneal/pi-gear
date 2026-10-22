import assert from "node:assert/strict";
import test from "node:test";
import {
  createBashToolDefinition,
  initTheme,
  type BashOperations,
  type ExtensionAPI,
  type ExtensionToolContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { ConfirmationQueue } from "./confirmation-queue.ts";
import { setupHostCommand, type CommandDetails, type requestCommandParameters } from "./host-command.ts";

initTheme();

function fixture(exec: BashOperations["exec"] = async () => ({ exitCode: 0 }), shared = false) {
  let tool!: ToolDefinition<typeof requestCommandParameters, CommandDetails>;
  const handlers: Record<string, () => void> = {};
  setupHostCommand({
    on: (event: string, handler: () => void) => { handlers[event] = handler; },
    registerTool: (registered: typeof tool) => { tool = registered; },
  } as unknown as ExtensionAPI, {
    ...(shared ? { confirmationQueue: new ConfirmationQueue() } : {}),
    createBashTool: (cwd) => createBashToolDefinition(cwd, { exposeSessionEnvironment: false, operations: { exec } }),
  });
  return { tool, handlers };
}

function context(ui: Record<string, unknown>, cwd = process.cwd()): ExtensionToolContext {
  return { cwd, hasUI: true, ui } as unknown as ExtensionToolContext;
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("request_command rejects invalid timeouts before approval or execution", async () => {
  for (const timeout of [0, -1, NaN, Infinity, -Infinity, 2_147_483.648]) {
    let executions = 0;
    let prompts = 0;
    const { tool } = fixture(async () => { executions++; return { exitCode: 0 }; });
    const result = await tool.execute("invalid", { command: "printf test", timeout }, undefined, undefined,
      context({ select: async () => { prompts++; return "Run"; } }));
    assert.equal(result.isError, true, String(timeout));
    assert.equal(result.details?.status, "Failed");
    const message = result.content.find((item) => item.type === "text");
    assert.match(message?.text ?? "", /Invalid timeout/);
    assert.equal(prompts, 0);
    assert.equal(executions, 0);
  }
});

test("request_command forwards valid timeouts and the approved cwd to native Bash", async () => {
  for (const timeout of [undefined, 0.001, 15, 2_147_483.647]) {
    const calls: Array<{ command: string; cwd: string; timeout: number | undefined }> = [];
    const { tool } = fixture(async (command, cwd, options) => {
      calls.push({ command, cwd, timeout: options.timeout });
      return { exitCode: 0 };
    });
    const ctx = context({ select: async () => { Object.assign(ctx, { cwd: "/changed-after-approval" }); return "Run"; } }, "/approved");
    const result = await tool.execute("valid", { command: "printf test", ...(timeout === undefined ? {} : { timeout }) }, undefined, undefined, ctx);
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls, [{ command: "printf test", cwd: "/approved", timeout }]);
  }
});

test("session lifecycle invalidates approval and shutdown denies later requests", async () => {
  for (const shared of [false, true]) {
    for (const event of ["session_start", "session_shutdown"]) {
      let executions = 0;
      let prompts = 0;
      const { tool, handlers } = fixture(async () => { executions++; return { exitCode: 0 }; }, shared);
      const ctx = context({ select: async (_title: string, _choices: string[], options: { signal: AbortSignal }) => {
        prompts++;
        handlers[event]!();
        assert.equal(options.signal.aborted, true);
        return "Run";
      } });
      const result = await tool.execute("stale", { command: "printf stale" }, undefined, undefined, ctx);
      assert.equal(result.isError, true);
      assert.equal(result.details?.status, "Cancelled");
      assert.equal(executions, 0);
      if (event === "session_shutdown") {
        await tool.execute("after-shutdown", { command: "printf stale" }, undefined, undefined, ctx);
        assert.equal(prompts, 1);
        assert.equal(executions, 0);
      }
    }
  }
});

test("caller abort dismisses an active selector without waiting for selection", async () => {
  const controller = new AbortController();
  let executions = 0;
  let dismissed = false;
  const { tool } = fixture(async () => { executions++; return { exitCode: 0 }; });
  const pending = tool.execute("abort", { command: "printf test" }, controller.signal, undefined,
    context({ select: (_title: string, _choices: string[], options: { signal: AbortSignal }) => new Promise((resolve) => {
      options.signal.addEventListener("abort", () => { dismissed = true; resolve(undefined); }, { once: true });
    }) }));
  await tick();
  controller.abort();
  const result = await pending;
  assert.equal(dismissed, true);
  assert.equal(result.details?.status, "Cancelled");
  assert.equal(executions, 0);
});

test("session change aborts an already-running native command", async () => {
  for (const event of ["session_start", "session_shutdown"]) {
    let running = false;
    let aborted = false;
    const { tool, handlers } = fixture(async (_command, _cwd, options) => {
      running = true;
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); }, { once: true });
      });
    }, true);
    const pending = tool.execute("running", { command: "printf test" }, undefined, undefined, context({ select: async () => "Run" }));
    await tick();
    assert.equal(running, true);
    handlers[event]!();
    const result = await pending;
    assert.equal(aborted, true);
    assert.equal(result.details?.status, "Cancelled");
    assert.equal(result.isError, true);
  }
});

test("RPC editing fails closed without opening an uncancellable dialog", async () => {
  let executions = 0;
  const { tool } = fixture(async () => { executions++; return { exitCode: 0 }; });
  let choice = "Edit";
  const ctx = context({
    select: async () => choice,
    editor: async () => assert.fail("uncancellable RPC editor opened"),
    custom: async () => assert.fail("terminal UI opened in RPC mode"),
  });
  Object.assign(ctx, { mode: "rpc" });
  const result = await tool.execute("rpc-edit", { command: "original" }, undefined, undefined, ctx);
  assert.equal(result.isError, true);
  assert.equal(result.details?.status, "Failed");
  assert.match(result.content.find((item) => item.type === "text")?.text ?? "", /requires terminal UI/);
  assert.equal(executions, 0);
  choice = "Run";
  await tool.execute("rpc-run", { command: "original" }, undefined, undefined, ctx);
  assert.equal(executions, 1);
});

test("approval editor cannot launch an uncancellable external editor", async () => {
  let executions = 0;
  let notifications = 0;
  const { tool } = fixture(async () => { executions++; return { exitCode: 0 }; });
  const ctx = context({
    select: async () => "Edit",
    notify: (message: string, severity: string) => {
      assert.match(message, /External editors are unavailable/);
      assert.equal(severity, "warning");
      notifications++;
    },
    custom: (factory: (...args: any[]) => any) => new Promise((resolve) => {
      const component = factory(
        { requestRender() {}, stop() { assert.fail("approval launched external editor"); } },
        {}, { matches: (_data: string, action: string) => action === "app.editor.external" }, resolve,
      );
      component.handleInput("external-editor-shortcut");
      component.dispose();
      resolve(undefined);
    }),
  });
  Object.assign(ctx, { mode: "tui" });
  const result = await tool.execute("external", { command: "original" }, undefined, undefined, ctx);
  assert.equal(notifications, 1);
  assert.equal(executions, 0);
  assert.equal(result.details?.status, "Cancelled");
});

test("native editor is dismissed on session change and late edited text cannot execute", async () => {
  let executions = 0;
  let editorOpened = false;
  let disposed = false;
  let lateSubmit!: (value: string | undefined) => void;
  const { tool, handlers } = fixture(async () => { executions++; return { exitCode: 0 }; });
  const ctx = context({
    select: async () => "Edit",
    custom: (factory: (...args: any[]) => any) => new Promise((resolve) => {
      let component: { dispose(): void };
      lateSubmit = (value) => { component?.dispose(); disposed = true; resolve(value); };
      component = factory({ requestRender() {} }, {}, { matches: () => false }, lateSubmit);
      editorOpened = true;
    }),
  });
  Object.assign(ctx, { mode: "tui" });
  const pending = tool.execute("editing", { command: "original" }, undefined, undefined, ctx);
  await tick();
  assert.equal(editorOpened, true);
  handlers.session_start!();
  const result = await pending;
  assert.equal(disposed, true);
  assert.equal(result.details?.status, "Cancelled");
  lateSubmit("edited after cancellation");
  assert.equal(executions, 0);
});
