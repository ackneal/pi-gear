import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
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

test("filesystem requests notify approval and denial without sending messages or changing authorization semantics", async () => {
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
    const messages: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        confirm: async (...args: unknown[]) => { confirmations.push(args); return allowed; },
        notify: (...args: unknown[]) => { notifications.push(args); },
      },
    } as unknown as ExtensionContext;
    const pi = { sendMessage: (message: unknown) => { messages.push(message); } } as unknown as ExtensionAPI;

    try {
      await mkdir(workspace);
      await writeFile(outside, "test");
      const access = new FilesystemAccess(workspace, {
        loadConfig: async () => policy(outside, false),
        tempSource: async () => join(root, "trusted-temp"),
      });
      const authorization = await access.authorize(outside, "read");
      assert.equal(authorization.decision, "ask");

      const result = await access.request(outside, "read", "read", ctx, pi);

      assert.deepEqual(result, { ...authorization, decision });
      assert.deepEqual(confirmations, [[
        "Outside workspace access",
        `Allow read access to ${authorization.path}?`,
        { timeout: CONFIRMATION_TIMEOUT_MS },
      ]]);
      assert.deepEqual(notifications, [[
        `User ${status} outside-workspace access: read ${authorization.path}`,
        severity,
      ]]);
      assert.deepEqual(messages, []);
      assert.deepEqual(await access.authorize(outside, "read"), authorization);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
