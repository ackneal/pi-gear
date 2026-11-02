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
      name: "handles standalone file without project pattern (transient once)",
      params: { fileLabel: "single.txt", projectPattern: undefined },
      inputs: ["\r"],
      expectedChoice: "allow-file-once",
      expectedPermanent: false,
    },
    {
      name: "handles standalone file without project pattern (permanent)",
      params: { fileLabel: "single.txt", projectPattern: undefined },
      inputs: ["\t", "\r"],
      expectedChoice: "always-allow-file",
      expectedPermanent: true,
    },
    {
      name: "handles standalone file toggle back to transient",
      params: { fileLabel: "single.txt", projectPattern: undefined },
      inputs: ["\t", "\t", "\r"],
      expectedChoice: "allow-file-once",
      expectedPermanent: false,
    },
    {
      name: "handles standalone file deny",
      params: { fileLabel: "single.txt", projectPattern: undefined },
      inputs: ["\x1b[B", "\r"],
      expectedChoice: "deny",
      expectedPermanent: false,
    },
  ];

  for (const { name, params, inputs, expectedChoice, expectedPermanent } of cases) {
    let resolvedChoice: FilesystemPromptChoice | undefined;

    const component = new FilesystemApprovalComponent(
      "Allow access?",
      params,
      dummyTheme,
      () => {},
      (choice) => { resolvedChoice = choice; },
    );

    for (const input of inputs) {
      component.handleInput(input);
    }

    assert.equal(resolvedChoice, expectedChoice, `${name} (choice)`);
    const firstLine = component.render(80)[0];
    const hasPermanentBadge = firstLine !== undefined && firstLine.includes("Always Allow");
    assert.equal(hasPermanentBadge, expectedPermanent, `${name} (permanent)`);
    assert.ok(component.render(80).length > 3, `${name} (render lines)`);
  }
});

test("promptFilesystemAccess dispatches to custom, select, or confirm based on UI capability", async () => {
  const inFlightAbortController = new AbortController();

  let capturedSelectOptions: string[] = [];

  const cases: Array<{
    name: string;
    params?: {
      path?: string;
      label?: string;
      projectPattern?: string | undefined;
      signal?: AbortSignal;
    };
    ctx: Partial<ExtensionContext>;
    expected: FilesystemPromptChoice;
    assertOptions?: (options: string[]) => void;
  }> = [
    {
      name: "custom: submits choice via custom component in TUI mode",
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
      name: "custom: returns deny on pre-aborted signal",
      params: { signal: AbortSignal.abort() },
      ctx: {
        mode: "tui",
        hasUI: true,
        ui: {
          custom: () => {
            assert.fail("custom should not be invoked when signal is already aborted");
          },
        } as any,
      },
      expected: "deny",
    },
    {
      name: "custom: resolves deny when signal aborts in-flight",
      params: { signal: inFlightAbortController.signal },
      ctx: {
        mode: "tui",
        hasUI: true,
        ui: {
          custom: ((factory: (tui: any, theme: any, kb: any, done: (res: FilesystemPromptChoice) => void) => any) => new Promise<FilesystemPromptChoice>((resolve) => {
            factory({ requestRender: () => undefined }, dummyTheme, {}, resolve);
            inFlightAbortController.abort();
          })) as any,
        } as any,
      },
      expected: "deny",
    },
    {
      name: "select: allows file once and verifies symmetrical options",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => {
            capturedSelectOptions = options;
            return options[0]!;
          },
        } as any,
      },
      expected: "allow-file-once",
      assertOptions: (options) => {
        assert.deepEqual(options, [
          "Allow file once (index.ts)",
          "Allow project for this session (/dev/repo/**)",
          "Always allow file (index.ts)",
          "Always allow project (/dev/repo/**)",
          "Deny",
        ]);
      },
    },
    {
      name: "select: allows project for session",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => options[1]!,
        } as any,
      },
      expected: "allow-project-session",
    },
    {
      name: "select: always allows file",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => options[2]!,
        } as any,
      },
      expected: "always-allow-file",
    },
    {
      name: "select: always allows project",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => options[3]!,
        } as any,
      },
      expected: "always-allow-project",
    },
    {
      name: "select: denies access",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => options[4]!,
        } as any,
      },
      expected: "deny",
    },
    {
      name: "select: handles standalone file without project pattern",
      params: { projectPattern: undefined },
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async (_title: string, options: string[]) => {
            capturedSelectOptions = options;
            return options[1]!;
          },
        } as any,
      },
      expected: "always-allow-file",
      assertOptions: (options) => {
        assert.deepEqual(options, [
          "Allow file once (index.ts)",
          "Always allow file (index.ts)",
          "Deny",
        ]);
      },
    },
    {
      name: "select: returns deny on pre-aborted signal",
      params: { signal: AbortSignal.abort() },
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          select: async () => {
            assert.fail("select should not be invoked when signal is already aborted");
          },
        } as any,
      },
      expected: "deny",
    },
    {
      name: "confirm: allows file once when confirmed",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          confirm: async () => true,
        } as any,
      },
      expected: "allow-file-once",
    },
    {
      name: "confirm: denies access when rejected",
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          confirm: async () => false,
        } as any,
      },
      expected: "deny",
    },
    {
      name: "confirm: returns deny on pre-aborted signal",
      params: { signal: AbortSignal.abort() },
      ctx: {
        mode: "json",
        hasUI: true,
        ui: {
          confirm: async () => {
            assert.fail("confirm should not be invoked when signal is already aborted");
          },
        } as any,
      },
      expected: "deny",
    },
  ];

  for (const { name, params, ctx, expected, assertOptions } of cases) {
    const choice = await promptFilesystemAccess({
      path: params?.path ?? "/dev/repo/src/index.ts",
      label: params?.label ?? "read",
      projectPattern: params !== undefined && "projectPattern" in params
        ? params.projectPattern
        : "/dev/repo/**",
      ctx: ctx as ExtensionContext,
      ...(params?.signal !== undefined ? { signal: params.signal } : {}),
    });

    assert.equal(choice, expected, `${name} (choice)`);
    if (assertOptions !== undefined) {
      assertOptions(capturedSelectOptions);
    }
  }
});
