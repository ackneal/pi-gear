import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AccessPolicy } from "../../config/types.ts";
import { evaluateFilesystem, followFallbackAccess, matchesFilesystemSelector } from "./filesystem.ts";

const policy = (overrides: Partial<AccessPolicy> = {}): AccessPolicy => ({
  filesystem: { rules: [], ...overrides.filesystem },
  network: { rules: [], ...overrides.network },
});

test("literal filesystem selectors include descendants but not similar prefixes", () => {
  const cases = [
    ["/home/user/.bun", "/home/user/.bun", true],
    ["/home/user/.bun", "/home/user/.bun/bin/bun", true],
    ["/home/user/.bun", "/home/user/.bun-other/file", false],
    ["config.json", "config.json", true],
    ["config.json", "config.json.backup", false],
  ] as const;

  for (const [selector, path, expected] of cases) {
    assert.equal(matchesFilesystemSelector(selector, path), expected, `${selector} against ${path}`);
  }
});

test("filesystem policy allows workspace access and asks outside it", () => {
  const access = policy();
  assert.equal(evaluateFilesystem(access, "/workspace", "/workspace/src/index.ts", "write"), "allow");
  assert.equal(evaluateFilesystem(access, "/workspace", "/outside/file.txt", "read"), "ask");
});

test("filesystem deny outranks allow and read-only blocks writes", () => {
  const access = policy({ filesystem: { rules: [
    { path: "src/**", access: "read-write" },
    { path: "src/secrets/**", access: "deny" },
    { path: "docs/**", access: "read-only" },
    { path: "~/.pi/agent/skills/**", access: "read-only" },
    { path: "~/.pi/agent/AGENTS.md", access: "read-only" },
  ] } });
  assert.equal(evaluateFilesystem(access, "/workspace", "/workspace/src/secrets/token", "read"), "deny");
  assert.equal(evaluateFilesystem(access, "/workspace", "/workspace/docs/guide.md", "read"), "allow");
  assert.equal(evaluateFilesystem(access, "/workspace", "/workspace/docs/guide.md", "write"), "deny");
  const skill = join(homedir(), ".pi/agent/skills/example/SKILL.md");
  const instructions = join(homedir(), ".pi/agent/AGENTS.md");
  assert.equal(evaluateFilesystem(access, "/workspace", skill, "read"), "allow");
  assert.equal(evaluateFilesystem(access, "/workspace", skill, "write"), "deny");
  assert.equal(evaluateFilesystem(access, "/workspace", instructions, "read"), "allow");
  assert.equal(evaluateFilesystem(access, "/workspace", instructions, "write"), "deny");
});

test("follow:true rules extend access to symlink targets while deny rules still win", () => {
  const access = policy({ filesystem: { rules: [
    { path: "~/.pi/agent/skills/**", access: "read-only", follow: true },
    { path: "~/.ssh/**", access: "deny" },
  ] } });

  const skillRaw = join(homedir(), ".pi/agent/skills/example/SKILL.md");
  const skillTarget = join(homedir(), ".dotfiles/ai-agents/skills/example/SKILL.md");
  const sshEscape = join(homedir(), ".ssh/id_rsa");

  // Raw path evaluation is unchanged.
  assert.equal(evaluateFilesystem(access, "/workspace", skillRaw, "read"), "allow");

  // The follow fallback carries the rule's access to the resolved target.
  const fallback = followFallbackAccess(access, "/workspace", skillRaw);
  assert.equal(fallback, "read-only");
  assert.equal(evaluateFilesystem(access, "/workspace", skillTarget, "read", fallback), "allow");
  assert.equal(evaluateFilesystem(access, "/workspace", skillTarget, "write", fallback), "deny");

  // Explicit deny on the target outranks the follow fallback: links cannot escape into denied areas.
  assert.equal(evaluateFilesystem(access, "/workspace", sshEscape, "read", fallback), "deny");

  // Without the fallback (no follow:true rule), the outside default asks.
  assert.equal(evaluateFilesystem(access, "/workspace", skillTarget, "read"), "ask");
  assert.equal(followFallbackAccess(access, "/workspace", join(homedir(), ".pi/agent/AGENTS.md")), undefined);
});
