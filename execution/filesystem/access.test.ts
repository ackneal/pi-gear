import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { FilesystemRule } from "../../config/index.ts";
import { CONFIRMATION_TIMEOUT_MS } from "../confirmation-queue.ts";
import { ConfirmationQueue } from "../confirmation-queue.ts";
import { FilesystemAccess } from "./access.ts";
import { createEffectiveSandboxConfig } from "../sandbox/config.ts";

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

test("filesystem requests notify approval and denial and retain session authorization", async () => {
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
        `Allow read access to ${authorization.path}? (Approved access applies to this session)`,
        { timeout: CONFIRMATION_TIMEOUT_MS, signal: options.signal },
      ]]);
      assert.deepEqual(notifications, [[
        `User ${status} outside-workspace access: read ${authorization.path}`,
        severity,
      ]]);
      assert.deepEqual(await access.authorize(outside, "read"), { ...authorization, decision });
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

    // 1. User selects "Allow project"
    nextSelection = `Allow project (${outsideProject}/**)`;
    const resultA = await access.request(fileA, "read", "read", ctx);
    assert.equal(resultA.decision, "allow");
    assert.equal(selections.length, 1);
    assert.ok(selections[0]?.some((opt) => opt.startsWith("Allow project")));

    // 2. Requesting fileB in the same project succeeds without prompting
    const resultB = await access.request(fileB, "read", "read", ctx);
    assert.equal(resultB.decision, "allow");
    assert.equal(selections.length, 1); // No new select prompt shown

    // 3. Requesting write access to fileA when only read was approved asks again
    nextSelection = "Always allow project";
    const resultWrite = await access.request(fileA, "write", "write", ctx);
    assert.equal(resultWrite.decision, "allow");
    assert.equal(selections.length, 2); // Prompted for write access
    assert.deepEqual(persisted, [{ path: `${outsideProject}/**`, access: "read-write" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("file choices distinguish session approval vs persistent approval and upgrade access", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-file-scopes-"));
  const workspace = join(root, "workspace");
  const fileOnce = join(root, "once.txt");
  const fileAlways = join(root, "always.txt");

  await mkdir(workspace);
  await writeFile(fileOnce, "once");
  await writeFile(fileAlways, "always");

  try {
    let promptCount = 0;
    let selectedOption = "";
    const persisted: unknown[] = [];
    const ctx = {
      hasUI: true,
      ui: {
        select: async (_title: string, options: string[]) => {
          promptCount++;
          return options.find((opt) => opt === selectedOption) ?? options[0];
        },
        notify: () => undefined,
      },
    } as unknown as ExtensionContext;

    const access = new FilesystemAccess(workspace, {
      loadConfig: async () => policy(fileOnce, false),
      persistRule: async (rule) => { persisted.push(rule); },
    });

    // 1. Allow file for session
    selectedOption = "Allow";
    const resOnce1 = await access.request(fileOnce, "read", "read", ctx);
    assert.equal(resOnce1.decision, "allow");
    assert.equal(promptCount, 1);

    // Reading fileOnce again in the same session does not prompt
    const resOnce2 = await access.request(fileOnce, "read", "read", ctx);
    assert.equal(resOnce2.decision, "allow");
    assert.equal(promptCount, 1);

    // Requesting write on fileOnce prompts again and upgrades read-only to read-write
    selectedOption = "Always allow";
    const resOnceWrite = await access.request(fileOnce, "write", "write", ctx);
    assert.equal(resOnceWrite.decision, "allow");
    assert.equal(promptCount, 2);
    assert.deepEqual(persisted, [{ path: fileOnce, access: "read-write" }]);

    // Writing to fileOnce again does not prompt
    const resOnceWrite2 = await access.request(fileOnce, "write", "write", ctx);
    assert.equal(resOnceWrite2.decision, "allow");
    assert.equal(promptCount, 2);
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
              const projectOption = options.find((opt) => opt.startsWith("Allow project")) ?? options[0]!;
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

test("concurrent request with abort signal does not abort independent concurrent caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-abort-isolation-"));
  const workspace = join(root, "workspace");
  const outsideFile = join(root, "outside.txt");

  await mkdir(workspace);
  await writeFile(outsideFile, "content");

  try {
    let resolvePrompt: ((choice: string) => void) | undefined;
    const ctx = {
      hasUI: true,
      ui: {
        select: (_title: string, options: string[]) => new Promise<string>((resolve) => {
          resolvePrompt = () => resolve(options[0]!);
        }),
        notify: () => undefined,
      },
    } as unknown as ExtensionContext;

    const access = new FilesystemAccess(workspace, { loadConfig: async () => policy(outsideFile, false) });
    const abortController = new AbortController();

    const reqAborted = access.request(outsideFile, "read", "read", ctx, abortController.signal);
    const reqNormal = access.request(outsideFile, "read", "read", ctx);

    // Abort first caller
    abortController.abort();
    const resAborted = await reqAborted;
    assert.equal(resAborted.decision, "ask"); // Aborted returns fallback

    // Wait until select prompt is reached
    while (resolvePrompt === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Normal caller should still resolve successfully when prompt resolves
    assert.ok(resolvePrompt);
    resolvePrompt("");
    const resNormal = await reqNormal;
    assert.equal(resNormal.decision, "allow");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("prompt callback delayed return after reset/clear does not apply approval or persist rule", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-delayed-prompt-"));
  const workspace = join(root, "workspace");
  const outsideFile = join(root, "outside.txt");

  await mkdir(workspace);
  await writeFile(outsideFile, "content");

  try {
    let resolvePrompt: ((choice: string) => void) | undefined;
    const notifications: string[] = [];
    const persisted: string[] = [];

    const ctx = {
      hasUI: true,
      ui: {
        select: (_title: string, options: string[]) => new Promise<string>((resolve) => {
          resolvePrompt = () => resolve(options[1]!); // "Always allow"
        }),
        notify: (msg: string) => notifications.push(msg),
      },
    } as unknown as ExtensionContext;

    const queue = new ConfirmationQueue();
    const access = new FilesystemAccess(workspace, {
      loadConfig: async () => policy(outsideFile, false),
      confirmationQueue: queue,
      persistRule: async (rule) => { persisted.push(rule.path); },
    });

    const pending = access.request(outsideFile, "read", "read", ctx);

    // Wait until prompt is active
    while (resolvePrompt === undefined) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    // Reset queue / clear session while prompt is open
    queue.reset();
    access.clear();

    const abortedOutcome = await pending;
    assert.equal(abortedOutcome.decision, "ask");

    // UI returns after session reset
    resolvePrompt("");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // Must not have persisted rule or added session approval
    assert.equal(persisted.length, 0);
    assert.equal(access.sessionApprovals.length, 0);
    assert.equal(notifications.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project session approvals respect canonical boundaries, follow rules, and denies", async () => {
  const cases = [
    { name: "ordinary project file", linked: false, follow: false, deny: false, decision: "allow" },
    { name: "escaping symlink", linked: true, follow: false, deny: false, decision: "ask" },
    { name: "intentional follow", linked: true, follow: true, deny: false, decision: "allow" },
    { name: "canonical deny with follow", linked: true, follow: true, deny: true, decision: "deny" },
    { name: "canonical deny without follow", linked: true, follow: false, deny: true, decision: "deny" },
    { name: "project deny", linked: false, follow: false, deny: true, decision: "deny" },
  ] as const;

  for (const row of cases) {
    const temporary = await mkdtemp(join(tmpdir(), "pi-gear-session-boundary-"));
    const root = await realpath(temporary);
    const workspace = join(root, "workspace");
    const project = join(root, "project");
    const external = join(root, "external.txt");
    const ordinary = join(project, "ordinary.txt");
    const linked = join(project, "linked.txt");
    const seed = join(project, "seed.txt");
    try {
      await mkdir(workspace);
      await mkdir(join(project, ".git"), { recursive: true });
      await writeFile(seed, "seed");
      await writeFile(ordinary, "ordinary");
      await writeFile(external, "external");
      await symlink(external, linked);
      const target = row.linked ? linked : ordinary;
      const rules: FilesystemRule[] = [];
      const config = { ...policy(target, false), filesystem: { rules } };
      let prompts = 0;
      const ctx = {
        hasUI: true,
        ui: {
          select: async () => {
            prompts++;
            return prompts === 1 ? `Allow project (${project}/**)` : "Deny";
          },
          notify: () => undefined,
        },
      } as unknown as ExtensionContext;
      const access = new FilesystemAccess(workspace, {
        loadConfig: async () => config,
        tempSource: async () => join(root, "trusted-temp"),
      });
      assert.equal((await access.request(seed, "write", "write", ctx)).decision, "allow");
      if (row.follow) rules.push({ path: linked, access: "read-write", follow: true });
      if (row.deny) rules.push({ path: row.linked ? external : ordinary, access: "deny" });

      assert.equal((await access.authorize(target, "write")).decision, row.decision, row.name);
      assert.equal((await access.request(target, "write", "write", ctx)).decision, row.decision, row.name);
      assert.equal(prompts, row.decision === "ask" ? 2 : 1, row.name);

      const sandbox = await createEffectiveSandboxConfig(workspace, {
        ...config, filesystem: { rules: access.getEffectiveRules(rules) },
      });
      assert.ok(sandbox.filesystem.allowWrite?.includes(`${project}/**`), row.name);
      assert.equal(sandbox.filesystem.allowWrite?.includes(external), row.follow, row.name);
      if (row.deny) {
        assert.ok(sandbox.filesystem.denyWrite?.includes(row.linked ? external : ordinary), row.name);
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test("approving a project from an escaping symlink does not approve its target", async () => {
  for (const permanent of [false, true]) {
    const temporary = await mkdtemp(join(tmpdir(), "pi-gear-project-choice-boundary-"));
    const root = await realpath(temporary);
    const project = join(root, "project");
    const workspace = join(root, "workspace");
    const external = join(root, "external.txt");
    const linked = join(project, "linked.txt");
    const persisted: FilesystemRule[] = [];
    try {
      await mkdir(workspace);
      await mkdir(join(project, ".git"), { recursive: true });
      await writeFile(external, "external");
      await symlink(external, linked);
      const access = new FilesystemAccess(workspace, {
        loadConfig: async () => policy(linked, false),
        tempSource: async () => join(root, "trusted-temp"),
        persistRule: async (rule) => { persisted.push(rule); },
      });
      const ctx = {
        hasUI: true,
        ui: {
          select: async () => permanent ? "Always allow project" : `Allow project (${project}/**)`,
          notify: () => undefined,
        },
      } as unknown as ExtensionContext;

      assert.equal((await access.request(linked, "read", "read", ctx)).decision, "ask");
      assert.equal((await access.authorize(external, "read")).decision, "ask");
      assert.deepEqual(persisted, permanent ? [{ path: `${project}/**`, access: "read-only" }] : []);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test("canonical filenames do not become wildcard session approvals", async () => {
  for (const projectApproval of [false, true]) {
    const temporary = await mkdtemp(join(tmpdir(), "pi-gear-canonical-star-"));
    const root = await realpath(temporary);
    const workspace = join(root, "workspace");
    const canonical = join(root, "secret*");
    const sibling = join(root, "secret-private");
    const alias = join(root, "alias");
    try {
      await mkdir(workspace);
      if (projectApproval) {
        await mkdir(join(canonical, ".git"), { recursive: true });
        await mkdir(sibling);
        await symlink(canonical, alias);
      } else {
        await writeFile(canonical, "secret");
        await writeFile(sibling, "private");
        await symlink(canonical, alias);
      }
      const access = new FilesystemAccess(workspace, {
        loadConfig: async () => policy(alias, false),
        tempSource: async () => join(root, "trusted-temp"),
      });
      const ctx = {
        hasUI: true,
        ui: {
          select: async () => projectApproval ? `Allow project (${alias}/**)` : "Allow",
          notify: () => undefined,
        },
      } as unknown as ExtensionContext;

      await access.request(alias, "write", "write", ctx);

      assert.equal((await access.authorize(sibling, "write")).decision, "ask");
      assert.ok(!access.getEffectiveRules().some((rule) => rule.path.startsWith(canonical)));
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test("getEffectiveRules does not override explicit deny rules with session approval", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-gear-effective-deny-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);

  try {
    const access = new FilesystemAccess(workspace);
    (access as any).sessionApprovals.push({ pattern: "**/.env", access: "read-write" });

    const baseRules = [{ path: "**/.env", access: "deny" as const }];
    const effective = access.getEffectiveRules(baseRules);

    assert.equal(effective.length, 1);
    assert.equal(effective[0]?.access, "deny");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
