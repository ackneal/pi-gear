import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FilesystemRule } from "../../config/index.ts";
import { CONFIRMATION_TIMEOUT_MS } from "../confirmation-queue.ts";
import { FilesystemAccess } from "./access.ts";

const policy = (path: string, deny: boolean) => ({
  version: 1 as const,
  filesystem: { rules: deny ? [{ path, access: "deny" as const }] : [] },
  sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
});

test("filesystem access reloads policy and recovers from loader failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-access-policy-"));
  const workspace = join(root, "workspace");
  const source = join(workspace, "source.ts");

  try {
    await mkdir(workspace);
    await writeFile(source, "test");

    let loads = 0;
    const access = new FilesystemAccess(workspace, {
      loadConfig: async () => {
        loads++;
        if (loads === 1) throw new Error("temporary failure");
        return policy(source, loads === 2);
      },
    });

    await assert.rejects(access.authorize(source, "read"), /temporary failure/);
    assert.equal((await access.authorize(source, "read")).decision, "deny");
    assert.equal((await access.authorize(source, "read")).decision, "allow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem requests notify approval and denial without changing authorization semantics", async () => {
  const cases = [
    { allowed: true, decision: "allow", status: "approved", severity: "info" },
    { allowed: false, decision: "ask", status: "denied", severity: "warning" },
  ] as const;

  for (const { allowed, decision, status, severity } of cases) {
    const root = await mkdtemp(join(process.cwd(), ".pi-gear-access-request-"));
    const workspace = join(root, "workspace");
    const outside = join(root, "outside.txt");
    const confirmations: unknown[][] = [];
    const notifications: unknown[][] = [];
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async (...args: unknown[]) => { confirmations.push(args); return allowed; },
        notify: (...args: unknown[]) => { notifications.push(args); },
      },
    } as unknown as ExtensionContext;

    try {
      await mkdir(workspace);
      await writeFile(outside, "test");
      const access = new FilesystemAccess(workspace, {
        loadConfig: async () => policy(outside, false),
        tempSource: async () => join(root, "trusted-temp"),
      });
      const authorization = await access.authorize(outside, "read");
      assert.equal(authorization.decision, "ask");

      const result = await access.request(outside, "read", "read", ctx);

      assert.deepEqual(result, { ...authorization, decision });
      const options = confirmations[0]?.[2] as { timeout: number; signal: AbortSignal };
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.signal.aborted, false);
      assert.deepEqual(confirmations, [[
        "Outside workspace access",
        `Allow read access to ${authorization.path}?`,
        { timeout: CONFIRMATION_TIMEOUT_MS, signal: options.signal },
      ]]);
      assert.deepEqual(notifications, [[
        `User ${status} outside-workspace access: read ${authorization.path}`,
        severity,
      ]]);
      assert.deepEqual(await access.authorize(outside, "read"), authorization);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("project approval options allow session-wide and persistent project access", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-project-approval-"));
  const workspace = join(root, "workspace");
  const outsideProject = join(root, "outside-project");
  const fileA = join(outsideProject, "src", "a.ts");
  const fileB = join(outsideProject, "src", "b.ts");

  await mkdir(workspace);
  await mkdir(join(outsideProject, "src"), { recursive: true });
  await mkdir(join(outsideProject, ".git"), { recursive: true });
  await writeFile(join(outsideProject, "package.json"), "{}");
  await writeFile(fileA, "content-a");
  await writeFile(fileB, "content-b");

  try {
    const persisted: FilesystemRule[] = [];
    const selections: string[][] = [];
    const notifications: unknown[][] = [];

    let nextSelection: string | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          selections.push(options);
          return nextSelection ?? options[0];
        },
        notify: (...args: unknown[]) => { notifications.push(args); },
      },
    } as unknown as ExtensionContext;

    const access = new FilesystemAccess(workspace, {
      loadConfig: async () => policy(fileA, false),
      persistRule: async (rule) => { persisted.push(rule); },
    });

    // 1. User selects "Allow project for this session"
    nextSelection = `Allow project for this session (${outsideProject}/**)`;
    const resultA = await access.request(fileA, "read", "read", ctx);
    assert.equal(resultA.decision, "allow");
    assert.equal(selections.length, 1);
    assert.ok(selections[0]?.some((opt) => opt.startsWith("Allow project for this session")));

    // 2. Requesting fileB in the same project succeeds without prompting
    const resultB = await access.request(fileB, "read", "read", ctx);
    assert.equal(resultB.decision, "allow");
    assert.equal(selections.length, 1); // No new select prompt shown

    // 3. Requesting write access to fileA when only read was approved asks again
    nextSelection = `Always allow project (${outsideProject}/**)`;
    const resultWrite = await access.request(fileA, "write", "write", ctx);
    assert.equal(resultWrite.decision, "allow");
    assert.equal(selections.length, 2); // Prompted for write access
    assert.deepEqual(persisted, [{ path: `${outsideProject}/**`, access: "read-write" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent outside-workspace requests share a prompt and deduplicate notifications", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-concurrent-fs-"));
  const workspace = join(root, "workspace");
  const outsideProject = join(root, "outside-project");
  const fileA = join(outsideProject, "a.ts");
  const fileB = join(outsideProject, "b.ts");

  await mkdir(workspace);
  await mkdir(join(outsideProject, ".git"), { recursive: true });
  await writeFile(fileA, "a");
  await writeFile(fileB, "b");

  try {
    let promptCount = 0;
    const notifications: unknown[][] = [];
    let resolvePrompt: ((choice: string) => void) | undefined;

    const ctx = {
      hasUI: true,
      ui: {
        select: (_title: string, options: string[]) => {
          promptCount++;
          return new Promise<string>((resolve) => {
            resolvePrompt = () => {
              const projectOption = options.find((opt) => opt.startsWith("Allow project for this session")) ?? options[0]!;
              resolve(projectOption);
            };
          });
        },
        notify: (...args: unknown[]) => { notifications.push(args); },
      },
    } as unknown as ExtensionContext;

    const access = new FilesystemAccess(workspace, {
      loadConfig: async () => policy(fileA, false),
    });

    // Case 1: Identical file concurrent requests share one prompt Promise
    const [req1, req2] = [
      access.request(fileA, "read", "read", ctx),
      access.request(fileA, "read", "read", ctx),
    ];

    while (promptCount < 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    assert.equal(promptCount, 1);
    resolvePrompt?.("");

    const [res1, res2] = await Promise.all([req1, req2]);
    assert.equal(res1.decision, "allow");
    assert.equal(res2.decision, "allow");
    assert.equal(notifications.length, 1);

    // Case 2: Sibling file in the same project auto-resolves because project is already approved
    const resB = await access.request(fileB, "read", "read", ctx);
    assert.equal(resB.decision, "allow");
    assert.equal(promptCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
