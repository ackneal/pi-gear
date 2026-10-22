import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { createSandboxBashTool, getCustomToolDefinition, lspToolRenderers, registerFileToolUi, setupFileToolUi, workspaceToolRenderers } from "./index.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

test("consecutive tool calls retain their own titles and results", () => {
  for (const kind of ["read", "write", "edit", "bash", "find", "grep", "diagnostics", "navigation"] as const) {
    let tool = getCustomToolDefinition(kind, "/workspace")!;
    if (kind === "read" || kind === "write" || kind === "edit") {
      registerFileToolUi({ getSettings: () => ({ outputPad: 0 }), registerTool: (definition: typeof tool) => {
        if (definition.name === kind) tool = definition;
      } } as unknown as ExtensionAPI, "/workspace");
    } else if (kind === "bash") {
      tool = createSandboxBashTool("/workspace", { exec: async () => ({ exitCode: 0 }) });
    } else {
      const renderers = kind === "find" || kind === "grep"
        ? workspaceToolRenderers(kind)
        : lspToolRenderers(kind);
      tool = { ...tool, ...renderers };
    }
    const components = ["first", "second"].map((id) => {
      const args = { path: `${id}.ts`, command: `echo ${id}`, pattern: id, content: id };
      const context = {
        args, cwd: "/workspace", expanded: false, isError: false,
        lastComponent: undefined, state: {}, executionStarted: false,
        invalidate: () => {}, argsComplete: true, isPartial: false,
        showImages: false, toolCallId: id,
      };
      const call = tool.renderCall!(args, theme, context);
      const result = tool.renderResult!({
        content: [{ type: "text", text: id }],
        details: { diff: `+${id}`, diagnostics: [], locations: [] },
      }, { expanded: false, isPartial: false }, theme, context);
      return { call, result };
    });

    for (const { call, result } of components) {
      const lines = [...call.render(120), ...result.render(120)];
      assert.ok(lines.some((line) => line.includes(kind === "navigation" ? "Navigation" : kind[0]!.toUpperCase() + kind.slice(1))), kind);
      assert.ok(result.render(120).length > 0, kind);
      assert.ok(!lines.some((line) => /tool calls|Tools \(/i.test(line)), kind);
      assert.equal("handleMouse" in call, false, kind);
    }
  }
});

test("file UI setup only registers session initialization, without grouping or mouse hooks", () => {
  const events: string[] = [];
  const pi = {
    getSettings: () => ({ outputPad: 0 }),
    on: (event: string) => { events.push(event); },
  } as unknown as ExtensionAPI;

  setupFileToolUi(pi);

  assert.deepEqual(events, ["session_start"]);
});
