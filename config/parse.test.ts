import assert from "node:assert/strict";
import test from "node:test";
import { parseExtensionConfig } from "./parse.ts";

const validConfig = (): unknown => ({
  version: 1,
  filesystem: { rules: [] },
  network: { rules: [] },
});

test("configuration parsing fails closed for invalid shapes and unsafe selectors", () => {
  assert.throws(() => parseExtensionConfig({}), /Invalid policy configuration/);
  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    filesystem: { rules: [{ path: "../secret", access: "deny" }] },
  }), /Invalid policy configuration/);
  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    network: { defaultAccess: "allow", rules: [] },
  }), /Invalid policy configuration/);
});

test("LSP configuration is optional, strict, and deeply frozen", () => {
  const withoutLsp = parseExtensionConfig(validConfig());
  assert.equal(withoutLsp.lsp, undefined);

  const config = parseExtensionConfig({
    ...validConfig() as object,
    lsp: {
      servers: [{
        extensions: [".ts", ".tsx"],
        command: ["typescript-language-server", "--stdio"],
      }],
    },
  });

  assert.deepEqual(config.lsp?.servers[0], {
    extensions: [".ts", ".tsx"],
    command: ["typescript-language-server", "--stdio"],
  });
  assert.ok(Object.isFrozen(config.lsp));
  assert.ok(Object.isFrozen(config.lsp?.servers));
  assert.ok(Object.isFrozen(config.lsp?.servers[0]));
  assert.ok(Object.isFrozen(config.lsp?.servers[0]?.extensions));
  assert.ok(Object.isFrozen(config.lsp?.servers[0]?.command));
});

test("LSP configuration rejects invalid entries and duplicate extension ownership", () => {
  const withServer = (server: unknown): unknown => ({
    ...validConfig() as object,
    lsp: { servers: [server] },
  });

  for (const server of [
    { extensions: [], command: ["server"] },
    { extensions: [".ts"], command: [] },
    { extensions: [""], command: ["server"] },
    { extensions: ["ts"], command: ["server"] },
    { extensions: [".ts/x"], command: ["server"] },
    { extensions: [".ts"], command: [""] },
    { extensions: [".ts"], command: ["server"], args: [] },
  ]) {
    assert.throws(() => parseExtensionConfig(withServer(server)), /Invalid policy configuration/);
  }

  for (const servers of [
    [{ extensions: [".ts", ".ts"], command: ["server"] }],
    [
      { extensions: [".ts"], command: ["first-server"] },
      { extensions: [".ts"], command: ["second-server"] },
    ],
  ]) {
    assert.throws(() => parseExtensionConfig({
      ...validConfig() as object,
      lsp: { servers },
    }), /duplicate extension \.ts/);
  }
  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    lsp: { servers: [], unknown: true },
  }), /invalid keys/);
});

test("filesystem rules accept an optional boolean follow flag", () => {
  const withFollow = parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      rules: [{ path: "~/.pi/agent/skills/**", access: "read-only", follow: true }],
    },
  });
  assert.equal(withFollow.filesystem.rules[0]?.follow, true);

  const withoutFollow = parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      rules: [{ path: "src/**", access: "read-only" }],
    },
  });
  assert.equal(withoutFollow.filesystem.rules[0]?.follow, undefined);

  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      rules: [{ path: "src/**", access: "read-only", follow: "yes" }],
    },
  }), /follow must be a boolean/);
  assert.throws(() => parseExtensionConfig({
    ...validConfig() as object,
    filesystem: {
      rules: [{ path: "src/**", access: "read-only", unknown: true }],
    },
  }), /invalid keys/);
});
