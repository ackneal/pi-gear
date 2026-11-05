import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccessPolicy, FilesystemRule } from "../../config/index.ts";
import { createEffectiveSandboxConfig } from "../sandbox/config.ts";
import { FilesystemAccess } from "./access.ts";

const policy = (rules: readonly FilesystemRule[]): AccessPolicy => ({
  filesystem: { rules: [...rules] },
  sandbox: { enabled: true, network: { rules: [], strictAllowlist: false } },
});

for (const operation of ["read", "write"] as const) {
  for (const scope of ["symlink", "ordinary", "project"] as const) {
    test(`${operation}: persistent ${scope} approval across sessions`, async (t) => {
      const temporary = await mkdtemp(join(tmpdir(), "pi-gear-access-persistence-"));
      try {
        // On macOS tmpdir may itself be an alias; ordinary files must not look linked.
        const root = await realpath(temporary);
        const workspace = join(root, "workspace");
        const directory = join(root, "outside");
        const canonical = join(root, "external.txt");
        const otherCanonical = join(root, "other-external.txt");
        const alias = join(directory, "alias.txt");
        const unrelated = join(directory, "unrelated.txt");
        const ordinary = join(directory, "ordinary.txt");
        const sibling = join(directory, "sibling.txt");
        await mkdir(workspace);
        await mkdir(directory);
        await writeFile(canonical, "external");
        await writeFile(otherCanonical, "other external");
        await writeFile(ordinary, "ordinary");
        await writeFile(sibling, "sibling");
        await symlink(canonical, alias);
        await symlink(otherCanonical, unrelated);
        if (scope === "project") await mkdir(join(directory, ".git"));

        const target = scope === "symlink" ? alias : ordinary;
        const pattern = scope === "project" ? `${directory}/**` : target;
        const access = operation === "read" ? "read-only" : "read-write";
        const persisted: FilesystemRule[] = [];
        const selections: string[][] = [];
        const ui = {
          select: async (_title, options) => {
            selections.push([...options]);
            const choice = scope === "project" ? "Always allow project" : "Always allow";
            assert.ok(options.includes(choice), "the intended persistent choice must be available");
            return choice;
          },
          notify: () => undefined,
        } satisfies Pick<ExtensionContext["ui"], "select" | "notify">;
        // Only these context members are consumed by filesystem prompting.
        const ctx = { hasUI: true, ui } as unknown as ExtensionContext;
        const options = {
          loadConfig: async () => policy(persisted),
          tempSource: async () => join(root, "trusted-temp"),
          persistRule: async (rule: FilesystemRule) => { persisted.push(rule); },
        };
        const initial = new FilesystemAccess(workspace, options);
        assert.equal((await initial.authorize(target, operation)).decision, "ask");
        assert.equal((await initial.request(target, operation, operation, ctx)).decision, "allow");
        assert.equal(selections.length, 1);
        if (scope !== "project") {
          assert.deepEqual(selections[0], ["Allow", "Always allow", "Deny"], "file approval has no project marker");
        }

        const fresh = new FilesystemAccess(workspace, options);
        assert.deepEqual(fresh.sessionApprovals, [], "reload cannot rely on session approvals");

        await t.test("persisted rule is confined to the chosen spelling and scope", () => {
          assert.deepEqual(persisted, [scope === "symlink"
            ? { path: pattern, access, follow: true }
            : { path: pattern, access }]);
        });

        await t.test("fresh session authorizes the approved target", async () => {
          assert.equal((await fresh.authorize(target, operation)).decision, "allow");
          if (scope === "project") {
            assert.equal((await fresh.authorize(sibling, operation)).decision, "allow");
          }
        });

        await t.test("approval does not escape to unrelated external targets", async () => {
          assert.equal((await fresh.authorize(unrelated, operation)).decision, "ask");
          assert.equal((await fresh.authorize(otherCanonical, operation)).decision, "ask");
          assert.equal((await fresh.authorize(canonical, operation)).decision, "ask", "no canonical rule is persisted");
          if (scope === "project") {
            assert.equal((await fresh.authorize(alias, operation)).decision, "ask", "project wildcard does not follow escaping links");
          }
        });

        for (const deny of ["lexical", "canonical"] as const) {
          await t.test(`${deny} explicit deny wins after reload`, async () => {
            const denyPath = deny === "lexical" ? target : scope === "symlink" ? canonical : ordinary;
            const denied = new FilesystemAccess(workspace, {
              ...options,
              loadConfig: async () => policy([...persisted, { path: denyPath, access: "deny" }]),
            });
            assert.equal((await denied.authorize(target, operation)).decision, "deny");
          });
        }

        await t.test("Bash effective config maps canonical access without widening scope", async () => {
          const sandbox = await createEffectiveSandboxConfig(workspace, policy(fresh.getEffectiveRules(persisted)));
          const writes = sandbox.filesystem.allowWrite ?? [];
          const deniedWrites = sandbox.filesystem.denyWrite ?? [];
          assert.equal(writes.includes(pattern), operation === "write");
          assert.equal(deniedWrites.includes(pattern), operation === "read");
          assert.equal(writes.includes(canonical), scope === "symlink" && operation === "write");
          assert.equal(deniedWrites.includes(canonical), scope === "symlink" && operation === "read");
          assert.equal(writes.includes(otherCanonical), false);
          assert.equal(deniedWrites.includes(otherCanonical), false);
        });
      } finally {
        await rm(temporary, { recursive: true, force: true });
      }
    });
  }
}
