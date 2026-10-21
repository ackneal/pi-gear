import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentToolResult,
  BashToolDetails,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIRMATION_TIMEOUT_MS, ConfirmationQueue } from "./confirmation-queue.ts";
import { REQUEST_COMMAND_TOOL_NAME, setupHostCommand } from "./host-command.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

function renderText(component: { render(width: number): string[] }, width = 200): string {
  return component
    .render(width)
    .map((line) => line.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trimEnd())
    .join("\n");
}

function createRegisteredHostTool(options: Parameters<typeof setupHostCommand>[1] = {}) {
  let registered: ToolDefinition<any, any, any> | undefined;
  const handlers: Record<string, () => void> = {};
  const pi = {
    on: (event: string, listener: () => void) => {
      handlers[event] = listener;
    },
    registerTool: (tool: ToolDefinition<any, any, any>) => {
      registered = tool;
    },
  } as unknown as ExtensionAPI;

  setupHostCommand(pi, options);
  assert.ok(registered);
  assert.equal(registered.name, REQUEST_COMMAND_TOOL_NAME);
  assert.equal(registered.exposure, "model-only");
  return { tool: registered, handlers };
}

test("request_command approval, editing, cancellation, and UI requirement", async () => {
  const cases = [
    {
      name: "approving Run command executes on host with timeout and reason in prompt",
      hasUI: true,
      params: { command: "docker ps", reason: "docker socket is outside sandbox", timeout: 15 },
      choice: "Run" as string | undefined,
      edited: undefined as string | undefined,
      expectedPrompt: "Run command?\n\ndocker socket is outside sandbox\n\n/workspace/project\n$ docker ps",
      expectedExecuted: { command: "docker ps", timeout: 15 },
      expectedError: undefined as RegExp | undefined,
    },
    {
      name: "selecting Edit command opens editor and executes trimmed edited command",
      hasUI: true,
      params: { command: "docker ps -a" },
      choice: "Edit",
      edited: "  docker ps --format '{{.Names}}'  ",
      expectedPrompt: "Run command?\n\n/workspace/project\n$ docker ps -a",
      expectedExecuted: { command: "docker ps --format '{{.Names}}'" },
      expectedError: undefined,
    },
    {
      name: "selecting Cancel throws declined error without executing",
      hasUI: true,
      params: { command: "rm -rf /tmp/test" },
      choice: "Cancel",
      edited: undefined,
      expectedPrompt: "Run command?\n\n/workspace/project\n$ rm -rf /tmp/test",
      expectedExecuted: undefined,
      expectedError: /^Error: User declined to run host command\.$/,
    },
    {
      name: "selecting undefined (timeout/escape) throws declined error without executing",
      hasUI: true,
      params: { command: "brew update" },
      choice: undefined,
      edited: undefined,
      expectedPrompt: "Run command?\n\n/workspace/project\n$ brew update",
      expectedExecuted: undefined,
      expectedError: /^Error: User declined to run host command\.$/,
    },
    {
      name: "cancelling editor with undefined throws declined error without executing",
      hasUI: true,
      params: { command: "git push" },
      choice: "Edit",
      edited: undefined,
      expectedPrompt: "Run command?\n\n/workspace/project\n$ git push",
      expectedExecuted: undefined,
      expectedError: /^Error: User declined to run host command\.$/,
    },
    {
      name: "cancelling editor with blank text throws declined error without executing",
      hasUI: true,
      params: { command: "git push" },
      choice: "Edit",
      edited: "   ",
      expectedPrompt: "Run command?\n\n/workspace/project\n$ git push",
      expectedExecuted: undefined,
      expectedError: /^Error: User declined to run host command\.$/,
    },
    {
      name: "calling without UI throws interactive UI required error",
      hasUI: false,
      params: { command: "ls" },
      choice: "Run",
      edited: undefined,
      expectedPrompt: undefined,
      expectedExecuted: undefined,
      expectedError: /^Error: Host command execution requires interactive UI confirmation\.$/,
    },
  ];

  for (const row of cases) {
    const executedCalls: Array<{ cwd: string; input: { command: string; timeout?: number } }> = [];
    const selectCalls: Array<{ title: string; options: string[]; timeout: number | undefined }> = [];
    const editorCalls: Array<{ title: string; prefill: string | undefined }> = [];

    const { tool } = createRegisteredHostTool({
      createBashTool: ((cwd: string) => ({
        name: "bash",
        label: "bash",
        description: "bash",
        parameters: {} as never,
        async execute(_id: string, input: { command: string; timeout?: number }): Promise<AgentToolResult<BashToolDetails | undefined>> {
          executedCalls.push({ cwd, input });
          return {
            content: [{ type: "text", text: `ran: ${input.command}` }],
            details: undefined,
          };
        },
      })) as never,
    });

    const ctx = {
      cwd: "/workspace/project",
      hasUI: row.hasUI,
      ui: {
        select: async (title: string, options: string[], opts?: { timeout?: number }) => {
          selectCalls.push({ title, options, timeout: opts?.timeout });
          return row.choice;
        },
        editor: async (title: string, prefill?: string) => {
          editorCalls.push({ title, prefill });
          return row.edited;
        },
      },
    } as unknown as ExtensionToolContext;

    if (row.expectedError) {
      if (!row.hasUI) {
        await assert.rejects(() => tool.execute("call-1", row.params, undefined, undefined, ctx), row.expectedError, row.name);
      } else {
        const result = await tool.execute("call-1", row.params, undefined, undefined, ctx);
        assert.equal(result.isError, true, row.name);
        assert.equal(result.details.status, "Cancelled", row.name);
        assert.deepEqual(result.content, [{ type: "text", text: "User declined to run command." }], row.name);
      }
      assert.equal(executedCalls.length, 0, row.name);
    } else {
      const result = await tool.execute("call-1", row.params, undefined, undefined, ctx);
      assert.deepEqual(executedCalls, [{ cwd: "/workspace/project", input: row.expectedExecuted! }], row.name);
      assert.deepEqual(result.content, [{ type: "text", text: `ran: ${row.expectedExecuted!.command}` }], row.name);
    }

    if (row.expectedPrompt !== undefined) {
      assert.deepEqual(
        selectCalls,
        [{ title: row.expectedPrompt, options: ["Run", "Edit", "Cancel"], timeout: CONFIRMATION_TIMEOUT_MS }],
        row.name,
      );
    } else {
      assert.equal(selectCalls.length, 0, row.name);
    }

    if (row.choice === "Edit" && row.hasUI) {
      assert.deepEqual(editorCalls, [{ title: "Edit command", prefill: row.params.command }], row.name);
    } else {
      assert.equal(editorCalls.length, 0, row.name);
    }
  }
});

test("request_command omits the current directory and empty reason from approval", async () => {
  const { tool } = createRegisteredHostTool();
  let title = "";
  const ctx = {
    cwd: process.cwd(), hasUI: true,
    ui: { select: async (prompt: string) => { title = prompt; return "Cancel"; } },
  } as unknown as ExtensionToolContext;
  await tool.execute("id", { command: "echo hello", reason: "   " }, undefined, undefined, ctx);
  assert.equal(title, "Run command?\n\n$ echo hello");
});

test("request_command serializes prompts through confirmationQueue and respects owned queue lifecycle", async () => {
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });

  const sharedQueue = new ConfirmationQueue();
  const { tool, handlers } = createRegisteredHostTool({
    confirmationQueue: sharedQueue,
    createBashTool: (() => ({
      name: "bash",
      label: "bash",
      description: "bash",
      parameters: {} as never,
      async execute(_id: string, input: { command: string }) {
        order.push(`exec:${input.command}`);
        return { content: [{ type: "text", text: input.command }], details: undefined };
      },
    })) as never,
  });

  assert.equal(handlers.session_start, undefined);
  assert.equal(handlers.session_shutdown, undefined);

  const ctx = {
    cwd: "/workspace",
    hasUI: true,
    ui: {
      select: async (title: string) => {
        order.push(`prompt:${title}`);
        if (title.includes("first")) await firstGate;
        return "Run";
      },
    },
  } as unknown as ExtensionToolContext;

  const first = tool.execute("1", { command: "first" }, undefined, undefined, ctx);
  const second = tool.execute("2", { command: "second" }, undefined, undefined, ctx);

  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(order, ["prompt:Run command?\n\n/workspace\n$ first"]);

  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "prompt:Run command?\n\n/workspace\n$ first",
    "exec:first",
    "prompt:Run command?\n\n/workspace\n$ second",
    "exec:second",
  ]);
});

test("request_command renders concise collapsed and expanded headers", () => {
  const { tool } = createRegisteredHostTool({
    createBashTool: (() => ({
      name: "bash",
      label: "bash",
      description: "bash",
      parameters: {} as never,
      async execute() {
        return { content: [], details: undefined };
      },
      renderResult: (result: AgentToolResult<BashToolDetails | undefined>) => {
        const text = result.content.find((item) => item.type === "text")?.text ?? "";
        return new Text(`base-rendered:${text}`, 0, 0);
      },
    })) as never,
  });

  const makeContext = (args: Record<string, unknown>, expanded = false, isError = false) =>
    ({
      args,
      cwd: "/workspace",
      expanded,
      isError,
      lastComponent: undefined,
      state: {},
      executionStarted: false,
      invalidate: () => undefined,
      argsComplete: true,
      isPartial: true,
      showImages: true,
      toolCallId: "test",
    }) as never;

  const collapsedCall = tool.renderCall!({ command: "echo hello\nworld" }, theme, makeContext({ command: "echo hello\nworld" }, false));
  const expandedCall = tool.renderCall!({ command: "echo hello" }, theme, makeContext({ command: "echo hello" }, true));

  assert.equal(renderText(collapsedCall), " · Command(echo hello world)");
  assert.equal(renderText(expandedCall), " · Command\n   echo hello");

  const sampleResult: AgentToolResult<BashToolDetails | undefined> = {
    content: [{ type: "text", text: "command output" }],
    details: undefined,
  };
  const collapsedResult = tool.renderResult!(
    sampleResult,
    { expanded: false, isPartial: false },
    theme,
    makeContext({ command: "echo hello" }, false, false),
  );
  const expandedResult = tool.renderResult!(
    sampleResult,
    { expanded: true, isPartial: false },
    theme,
    makeContext({ command: "echo hello" }, true, false),
  );
  const errorResult = tool.renderResult!(
    sampleResult,
    { expanded: false, isPartial: false },
    theme,
    makeContext({ command: "echo hello" }, false, true),
  );

  assert.equal(renderText(collapsedResult), " ● Command(echo hello)\n   └ command output");
  assert.equal(renderText(expandedResult), " ● Command\n   echo hello\n   base-rendered:command output");
  assert.equal(renderText(errorResult), " ✗ Command(echo hello)\n   └ command output");
});

test("request_command lifecycle preserves edited command, native output and real exit codes", async () => {
  for (const exitCode of [undefined, 0, 7]) {
    const updates: AgentToolResult<any>[] = [];
    const { tool } = createRegisteredHostTool({
      createBashTool: (() => ({
        async execute(_id: string, input: { command: string }, _signal: unknown, update: (result: AgentToolResult<any>) => void) {
          assert.equal(input.command, "edited");
          update({ content: [{ type: "text", text: "partial" }], details: undefined });
          return { content: [{ type: "text", text: "first\nlast" }], details: undefined,
            ...(exitCode !== undefined ? { structuredContent: { exit_code: exitCode }, isError: exitCode !== 0 } : {}) };
        },
      })) as never,
    });
    const ctx = { cwd: "/workspace", hasUI: true, ui: { select: async () => "Edit", editor: async () => " edited " } } as unknown as ExtensionToolContext;
    const result = await tool.execute("id", { command: "original" }, undefined, (value) => updates.push(value), ctx);
    assert.deepEqual(updates.map((value) => value.details.status), ["Waiting approval", "Running", "Running"]);
    assert.equal(result.details.command, "edited");
    assert.deepEqual(result.structuredContent, exitCode === undefined ? undefined : { exit_code: exitCode });
    assert.deepEqual(result.content, [{ type: "text", text: "first\nlast" }]);
    const context = { args: { command: "original" }, state: {}, isError: exitCode === 7 } as never;
    const rendered = renderText(tool.renderResult!(result, { expanded: false, isPartial: false }, theme, context));
    assert.equal(rendered.split("\n")[0], ` ${exitCode === 7 ? "✗" : "●"} Command(edited)`);
    assert.ok(rendered.endsWith("└ last"));
    assert.equal(rendered.includes("exit 0"), false);
  }
});

test("request_command composes one header and retains terminal error metadata", () => {
  const { tool } = createRegisteredHostTool();
  for (const row of [
    { status: "Cancelled", isError: true },
    { status: "Failed", isError: true },
    { status: "Running", isError: true },
    { status: "Completed", isError: false },
  ]) {
    const context = { args: { command: "original" }, state: {}, executionStarted: true, isPartial: true, isError: false };
    context.isPartial = false;
    context.isError = row.isError;
    assert.deepEqual(tool.renderCall!({ command: "original" }, theme, context as never).render(100), []);
    const rendered = renderText(tool.renderResult!({ content: [{ type: "text", text: "final output" }], details: { command: "edited", status: row.status } }, { expanded: false, isPartial: false }, theme, context as never));
    assert.equal(rendered.split("\n")[0], ` ${row.isError ? "✗" : "●"} Command(edited)`);
  }
  const historical = { args: { command: "original" }, state: {}, executionStarted: false, isPartial: false };
  assert.deepEqual(tool.renderCall!({ command: "original" }, theme, historical as never).render(100), []);
});

test("request_command preserves edited command and error metadata for restored results", async () => {
  for (const aborted of [false, true]) {
    const controller = new AbortController();
    const { tool } = createRegisteredHostTool({ createBashTool: (() => ({
      async execute() {
        if (aborted) controller.abort();
        throw new Error(aborted ? "Command aborted" : "Command timed out after 1 seconds");
      },
    })) as never });
    const ctx = { cwd: "/workspace", hasUI: true, ui: { select: async () => "Edit", editor: async () => "edited" } } as unknown as ExtensionToolContext;
    const result = await tool.execute("id", { command: "original" }, controller.signal, undefined, ctx);
    assert.equal(result.isError, true);
    assert.equal(result.details.command, "edited");
    assert.equal(result.details.status, aborted ? "Cancelled" : "Failed");
    const context = { args: { command: "original" }, state: {}, isError: true, executionStarted: false, isPartial: false } as never;
    assert.deepEqual(tool.renderCall!({ command: "original" }, theme, context).render(100), []);
    const rendered = renderText(tool.renderResult!(result, { expanded: false, isPartial: false }, theme, context));
    assert.equal(rendered.split("\n")[0], " ✗ Command(edited)");
    assert.ok(rendered.includes(aborted ? "Command aborted" : "Command timed out"));
  }
});

test("request_command never executes when aborted before or during approval or while queued", async () => {
  for (const stage of ["before", "approval", "queued", "editor"]) {
    const controller = new AbortController();
    const queue = new ConfirmationQueue();
    let release!: () => void;
    const blocker = stage === "queued" ? queue.confirm(() => new Promise<boolean>((resolve) => { release = () => resolve(true); })) : undefined;
    let executed = false;
    let prompted = false;
    const updates: AgentToolResult<any>[] = [];
    const { tool } = createRegisteredHostTool({ confirmationQueue: queue, createBashTool: (() => ({
      async execute() { executed = true; return { content: [], details: undefined }; },
    })) as never });
    if (stage === "before") controller.abort();
    const ctx = { cwd: "/workspace", hasUI: true, ui: {
      select: async () => { prompted = true; if (stage === "approval") controller.abort(); return stage === "editor" ? "Edit" : "Run"; },
      editor: async () => { controller.abort(); return "edited"; },
    } } as unknown as ExtensionToolContext;
    const pending = tool.execute("id", { command: "original" }, controller.signal, (value) => updates.push(value), ctx);
    const cancelled = pending.then((result) => {
      assert.equal(result.isError, true, stage);
      assert.equal(result.details.status, "Cancelled", stage);
      assert.deepEqual(result.content, [{ type: "text", text: "Command aborted before execution." }], stage);
    });
    if (stage === "queued") {
      await new Promise((resolve) => setImmediate(resolve));
      controller.abort();
      release();
      await blocker;
    }
    await cancelled;
    assert.equal(executed, false, stage);
    assert.equal(prompted, stage === "approval" || stage === "editor", stage);
    assert.equal(updates.at(-1)?.details.status, "Cancelled");
  }
});
