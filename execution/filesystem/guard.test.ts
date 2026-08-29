import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setupFilesystemGuard as setupFilesystemGuardImpl } from "./guard.ts";

const testConfig = {
  version: 1,
  filesystem: { rules: [{ path: "~/.ssh", access: "deny" as const }] },
  sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
} as const;

const setupFilesystemGuard = (
  pi: ExtensionAPI,
  options: Parameters<typeof setupFilesystemGuardImpl>[1] = {},
): void => { setupFilesystemGuardImpl(pi, { ...options, loadConfig: async () => testConfig }); };

type ToolCall = { type: "tool_call"; toolName: string; toolCallId: string; input: Record<string, unknown> };

test("headless outside-workspace file access is denied when policy asks", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pi-gear-file-guard-"));
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  try {
    await mkdir(join(workspace, "project"));
    setupFilesystemGuard(pi);
    assert.ok(handler);
    const result = await handler(
      { type: "tool_call", toolName: "read", toolCallId: "test-read", input: { path: `/pi-gear-outside-${process.pid}.txt` } },
      { cwd: join(workspace, "project"), hasUI: false } as ExtensionContext,
    );
    assert.deepEqual(result, {
      block: true,
      reason: "Access outside the workspace requires confirmation.",
    });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("dangling symlink writes are blocked as outside-workspace access", async () => {
  // A temp root outside follow-covered paths (such as /tmp/** when TMPDIR
  // points into it) keeps the dangling target outside the workspace boundary.
  const root = await mkdtemp(join(process.cwd(), ".pi-gear-file-guard-"));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  try {
    await Promise.all([mkdir(workspace), mkdir(outside)]);
    await symlink("/private/pi-gear-dangling-target", join(workspace, "escape"));
    setupFilesystemGuard(pi);
    assert.ok(handler);
    const result = await handler(
      { type: "tool_call", toolName: "write", toolCallId: "test-dangling-write", input: { path: "escape/new.txt" } },
      { cwd: workspace, hasUI: false } as ExtensionContext,
    );
    assert.deepEqual(result, {
      block: true,
      reason: "Access outside the workspace requires confirmation.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("built-in tmp access does not follow symlinks outside temp roots", async () => {
  const root = await mkdtemp(join("/tmp", "pi-gear-follow-guard-"));
  const workspace = join(root, "workspace");
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  try {
    await mkdir(workspace);
    await symlink("/private/pi-gear-follow-target", join(workspace, "escape"));
    setupFilesystemGuard(pi);
    assert.ok(handler);
    const result = await handler(
      { type: "tool_call", toolName: "write", toolCallId: "test-follow-write", input: { path: "escape/new.txt" } },
      { cwd: workspace, hasUI: false } as ExtensionContext,
    );
    assert.deepEqual(result, {
      block: true,
      reason: "Access outside the workspace requires confirmation.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("follow cannot escape into deny-covered targets", async () => {
  const root = await mkdtemp(join("/tmp", "pi-gear-follow-guard-"));
  const workspace = join(root, "workspace");
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  try {
    await mkdir(workspace);
    await symlink(join(homedir(), ".ssh"), join(workspace, "escape"));
    setupFilesystemGuard(pi);
    assert.ok(handler);
    const result = await handler(
      { type: "tool_call", toolName: "write", toolCallId: "test-follow-deny", input: { path: "escape/id_rsa" } },
      { cwd: workspace, hasUI: false } as ExtensionContext,
    );
    assert.deepEqual(result, {
      block: true,
      reason: "Access is not permitted.",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("task_state, researcher, and Bash pass without warnings", async () => {
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const warnings: string[] = [];
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  setupFilesystemGuard(pi);
  assert.ok(handler);

  for (const toolName of ["task_state", "researcher", "bash"] as const) {
    const result = await handler(
      { type: "tool_call", toolName, toolCallId: `test-${toolName}`, input: {} },
      {
        cwd: process.cwd(),
        hasUI: true,
        ui: { notify: (message: string) => warnings.push(message) },
      } as unknown as ExtensionContext,
    );
    assert.equal(result, undefined);
  }

  assert.deepEqual(warnings, []);
});

test("recursive filesystem tools use the same read policy without warnings", async () => {
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const warnings: string[] = [];
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd: process.cwd(),
    hasUI: true,
    ui: { notify: (message: string) => warnings.push(message) },
  } as unknown as ExtensionContext;
  setupFilesystemGuard(pi);
  assert.ok(handler);

  for (const toolName of ["grep", "ls", "find"] as const) {
    assert.equal(await handler({ type: "tool_call", toolName, toolCallId: `test-${toolName}`, input: {} }, ctx), undefined);
  }

  assert.deepEqual(warnings, []);
});

test("current process temp dir access skips the outside-workspace prompt", async () => {
  const root = await mkdtemp(join(process.cwd(), ".pi-gear-guard-temp-"));
  const tempRoot = join(root, "tmpdir");
  const workspace = join(root, "workspace");
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  try {
    await Promise.all([mkdir(tempRoot), mkdir(workspace)]);
    await writeFile(join(tempRoot, "clipboard.png"), "image");
    setupFilesystemGuard(pi, { tempSource: async () => `${tempRoot}/` });
    assert.ok(handler);
    const ctx = { cwd: workspace, hasUI: false } as ExtensionContext;

    assert.equal(
      await handler(
        { type: "tool_call", toolName: "read", toolCallId: "test-tmp-read", input: { path: join(tempRoot, "clipboard.png") } },
        ctx,
      ),
      undefined,
    );
    await handler(
      { type: "tool_call", toolName: "write", toolCallId: "test-tmp-write", input: { path: join(tempRoot, "out.txt") } },
      ctx,
    ).then((result) => assert.equal(result, undefined));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("sibling temp roots still require confirmation", async () => {
  const root = await mkdtemp(join(process.cwd(), ".pi-gear-guard-sibling-"));
  const tempRoot = join(root, "current");
  const sibling = join(root, "other");
  const workspace = join(root, "workspace");
  let handler: ((event: ToolCall, ctx: ExtensionContext) => Promise<unknown>) | undefined;
  const pi = {
    on: (event: string, listener: unknown) => {
      if (event === "tool_call") handler = listener as typeof handler;
    },
    sendMessage: () => undefined,
  } as unknown as ExtensionAPI;
  try {
    await Promise.all([mkdir(tempRoot), mkdir(sibling), mkdir(workspace)]);
    await writeFile(join(sibling, "file.txt"), "x");
    setupFilesystemGuard(pi, { tempSource: async () => tempRoot });
    assert.ok(handler);

    assert.deepEqual(
      await handler(
        { type: "tool_call", toolName: "read", toolCallId: "test-sibling-read", input: { path: join(sibling, "file.txt") } },
        { cwd: workspace, hasUI: false } as ExtensionContext,
      ),
      { block: true, reason: "Access outside the workspace requires confirmation." },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
