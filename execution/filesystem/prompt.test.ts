import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  promptFilesystemAccess,
  type FilesystemPromptChoice,
} from "./prompt.ts";

test("promptFilesystemAccess presents native select options with project detected", async () => {
  let capturedTitle = "";
  let capturedOptions: string[] = [];

  const ctx = {
    hasUI: true,
    ui: {
      select: async (title: string, options: string[]) => {
        capturedTitle = title;
        capturedOptions = options;
        return options[0]!;
      },
    },
  } as unknown as ExtensionContext;

  const choice = await promptFilesystemAccess({
    path: "/dev/repo/src/index.ts",
    label: "read",
    projectPattern: "/dev/repo/**",
    ctx,
  });

  assert.equal(choice, "allow-file");
  assert.ok(capturedTitle.includes("Allow read access to /dev/repo/src/index.ts?"));
  assert.ok(capturedTitle.includes("(Approved access applies to this session)"));
  assert.deepEqual(capturedOptions, [
    "Allow",
    "Allow project (/dev/repo/**)",
    "Always allow project",
    "Deny",
  ]);
});

test("promptFilesystemAccess presents native select options for standalone file without project", async () => {
  let capturedOptions: string[] = [];

  const ctx = {
    hasUI: true,
    ui: {
      select: async (_title: string, options: string[]) => {
        capturedOptions = options;
        return "Always allow";
      },
    },
  } as unknown as ExtensionContext;

  const choice = await promptFilesystemAccess({
    path: "/Users/user/.gitconfig",
    label: "read",
    projectPattern: undefined,
    ctx,
  });

  assert.equal(choice, "always-allow-file");
  assert.deepEqual(capturedOptions, [
    "Allow",
    "Always allow",
    "Deny",
  ]);
});

test("promptFilesystemAccess correctly maps every option when project detected", async () => {
  const selections: Array<{ option: string; expected: FilesystemPromptChoice }> = [
    { option: "Allow", expected: "allow-file" },
    { option: "Allow project (/dev/repo/**)", expected: "allow-project" },
    { option: "Always allow project", expected: "always-allow-project" },
    { option: "Deny", expected: "deny" },
    { option: "unknown", expected: "deny" },
  ];

  for (const { option, expected } of selections) {
    const ctx = {
      hasUI: true,
      ui: {
        select: async () => option,
      },
    } as unknown as ExtensionContext;

    const choice = await promptFilesystemAccess({
      path: "/dev/repo/src/index.ts",
      label: "write",
      projectPattern: "/dev/repo/**",
      ctx,
    });

    assert.equal(choice, expected, `Selection "${option}" should yield "${expected}"`);
  }
});

test("promptFilesystemAccess returns deny on pre-aborted signal", async () => {
  const ctx = {
    hasUI: true,
    ui: {
      select: async () => {
        assert.fail("select should not be called when pre-aborted");
      },
    },
  } as unknown as ExtensionContext;

  const choice = await promptFilesystemAccess({
    path: "/dev/repo/src/index.ts",
    label: "read",
    projectPattern: "/dev/repo/**",
    ctx,
    signal: AbortSignal.abort(),
  });

  assert.equal(choice, "deny");
});

test("promptFilesystemAccess falls back to confirm when select is unavailable", async () => {
  const ctxConfirmed = {
    hasUI: true,
    ui: {
      confirm: async () => true,
    },
  } as unknown as ExtensionContext;

  const choiceAllow = await promptFilesystemAccess({
    path: "/dev/repo/src/index.ts",
    label: "read",
    projectPattern: "/dev/repo/**",
    ctx: ctxConfirmed,
  });
  assert.equal(choiceAllow, "allow-file");

  const ctxDenied = {
    hasUI: true,
    ui: {
      confirm: async () => false,
    },
  } as unknown as ExtensionContext;

  const choiceDeny = await promptFilesystemAccess({
    path: "/dev/repo/src/index.ts",
    label: "read",
    projectPattern: "/dev/repo/**",
    ctx: ctxDenied,
  });
  assert.equal(choiceDeny, "deny");
});
