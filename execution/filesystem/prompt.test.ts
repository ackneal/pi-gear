import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  FilesystemApprovalComponent,
  promptFilesystemAccess,
  type FilesystemPromptChoice,
} from "./prompt.ts";

const dummyTheme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

test("FilesystemApprovalComponent handles Tab toggle, arrow navigation, and submission", () => {
  const cases: Array<{
    name: string;
    params: { fileLabel: string; projectPattern: string | undefined };
    inputs: string[];
    expectedChoice: FilesystemPromptChoice;
    expectedPermanent: boolean;
  }> = [
    {
      name: "submits default transient file choice without Tab",
      params: { fileLabel: "index.ts", projectPattern: "repo/**" },
      inputs: ["\r"],
      expectedChoice: "allow-file-once",
      expectedPermanent: false,
    },
    {
      name: "submits transient project choice after down arrow",
      params: { fileLabel: "index.ts", projectPattern: "repo/**" },
      inputs: ["\x1b[B", "\r"],
      expectedChoice: "allow-project-session",
      expectedPermanent: false,
    },
    {
      name: "submits permanent file choice after Tab",
      params: { fileLabel: "index.ts", projectPattern: "repo/**" },
      inputs: ["\t", "\r"],
      expectedChoice: "always-allow-file",
      expectedPermanent: true,
    },
    {
      name: "submits permanent project choice after Tab and down arrow",
      params: { fileLabel: "index.ts", projectPattern: "repo/**" },
      inputs: ["\t", "\x1b[B", "\r"],
      expectedChoice: "always-allow-project",
      expectedPermanent: true,
    },
    {
      name: "toggles Tab back to transient mode",
      params: { fileLabel: "index.ts", projectPattern: "repo/**" },
      inputs: ["\t", "\t", "\r"],
      expectedChoice: "allow-file-once",
      expectedPermanent: false,
    },
    {
      name: "submits deny on escape",
      params: { fileLabel: "index.ts", projectPattern: "repo/**" },
      inputs: ["\x1b"],
      expectedChoice: "deny",
      expectedPermanent: false,
    },
    {
      name: "wraps selection around on up arrow",
      params: { fileLabel: "index.ts", projectPattern: "repo/**" },
      inputs: ["\x1b[A", "\r"],
      expectedChoice: "deny",
      expectedPermanent: false,
    },
    {
      name: "handles standalone file without project pattern",
      params: { fileLabel: "single.txt", projectPattern: undefined },
      inputs: ["\t", "\r"],
      expectedChoice: "always-allow-file",
      expectedPermanent: true,
    },
  ];

  for (const { name, params, inputs, expectedChoice, expectedPermanent } of cases) {
    let resolvedChoice: FilesystemPromptChoice | undefined;
    let renders = 0;

    const component = new FilesystemApprovalComponent(
      "Allow access?",
      params,
      dummyTheme,
      () => { renders++; },
      (choice) => { resolvedChoice = choice; },
    );

    for (const input of inputs) {
      component.handleInput(input);
    }

    assert.equal(resolvedChoice, expectedChoice, `${name} (choice)`);
    assert.equal(component.isPermanent, expectedPermanent, `${name} (permanent)`);
    assert.ok(component.render(80).length > 3, `${name} (render lines)`);
  }
});

test("promptFilesystemAccess dispatches to custom, select, or confirm based on UI capability", async () => {
  const cases: Array<{
    name: string;
    ctx: Partial<ExtensionContext>;
    expected: FilesystemPromptChoice;
  }> = [
    {
      name: "uses ctx.ui.custom in TUI mode",
      ctx: {
        mode: "tui",
        hasUI: true,
        ui: {
          custom: ((factory: (tui: any, theme: any, kb: any, done: (res: FilesystemPromptChoice) => void) => any) => new Promise<FilesystemPromptChoice>((resolve) => {
            const comp = factory({ requestRender: () => undefined }, dummyTheme, {}, resolve);
            (comp as FilesystemApprovalComponent).handleInput("\t");
            (comp as FilesystemApprovalComponent).handleInput("\r");
          })) as any,
        } as any,
      },
      expected: "always-allow-file",
    },
    {
      name: "falls back to ctx.ui.select in non-custom mode",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => options.find((opt) => opt.startsWith("Allow project")) ?? options[0]!,
        } as any,
      },
      expected: "allow-project-session",
    },
    {
      name: "falls back to ctx.ui.confirm when select is unavailable",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          confirm: async () => true,
        } as any,
      },
      expected: "allow-file-once",
    },
  ];

  for (const { name, ctx, expected } of cases) {
    const choice = await promptFilesystemAccess({
      path: "/dev/repo/src/index.ts",
      label: "read",
      projectRoot: "/dev/repo",
      ctx: ctx as ExtensionContext,
    });
    assert.equal(choice, expected, name);
  }
});
