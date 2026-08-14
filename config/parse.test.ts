import assert from "node:assert/strict";
import test from "node:test";
import { parseExtensionConfig } from "./parse.ts";

const validConfig = (): unknown => ({
  version: 1,
  filesystem: { workspaceDefault: "read-write", outsideWorkspaceDefault: "ask", rules: [] },
  network: { defaultAccess: "ask", rules: [] },
});

test("configuration parsing fails closed for invalid shapes and unsafe selectors", () => {
  assert.throws(() => parseExtensionConfig({}), /Invalid policy configuration/);
  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    filesystem: { workspaceDefault: "read-write", outsideWorkspaceDefault: "ask", rules: [{ path: "../secret", access: "deny" }] },
  }), /Invalid policy configuration/);
  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    network: { defaultAccess: "allow", rules: [] },
  }), /Invalid policy configuration/);
});

test("filesystem rules accept an optional boolean follow flag", () => {
  const withFollow = parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      workspaceDefault: "read-write",
      outsideWorkspaceDefault: "ask",
      rules: [{ path: "~/.pi/agent/skills/**", access: "read-only", follow: true }],
    },
  });
  assert.equal(withFollow.filesystem.rules[0]?.follow, true);

  const withoutFollow = parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      workspaceDefault: "read-write",
      outsideWorkspaceDefault: "ask",
      rules: [{ path: "src/**", access: "read-only" }],
    },
  });
  assert.equal(withoutFollow.filesystem.rules[0]?.follow, undefined);

  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      workspaceDefault: "read-write",
      outsideWorkspaceDefault: "ask",
      rules: [{ path: "src/**", access: "read-only", follow: "yes" }],
    },
  }), /follow must be a boolean/);
  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      workspaceDefault: "read-write",
      outsideWorkspaceDefault: "ask",
      rules: [{ path: "src/**", access: "read-only", unknown: true }],
    },
  }), /invalid keys/);
});
