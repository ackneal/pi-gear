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

test("LSP configuration is optional, applies defaults, and is deeply frozen", () => {
  const withoutLsp = parseExtensionConfig(validConfig());
  assert.equal(withoutLsp.lsp, undefined);

  const config = parseExtensionConfig({
    ...validConfig() as object,
    lsp: {
      servers: [{
        extensions: [".ts", ".tsx"],
        languageIds: { ".ts": "typescript", ".tsx": "typescriptreact" },
        command: ["typescript-language-server", "--stdio"],
      }],
    },
  });

  assert.deepEqual(config.lsp, {
    servers: [{
      extensions: [".ts", ".tsx"],
      languageIds: { ".ts": "typescript", ".tsx": "typescriptreact" },
      command: ["typescript-language-server", "--stdio"],
    }],
    idleTimeoutMinutes: 15,
  });
  assert.ok(Object.isFrozen(config.lsp));
  assert.ok(Object.isFrozen(config.lsp?.servers));
  assert.ok(Object.isFrozen(config.lsp?.servers[0]));
  assert.ok(Object.isFrozen(config.lsp?.servers[0]?.extensions));
  assert.ok(Object.isFrozen(config.lsp?.servers[0]?.languageIds));
  assert.ok(Object.isFrozen(config.lsp?.servers[0]?.command));

  const disabledTimeout = parseExtensionConfig({
    ...validConfig() as object,
    lsp: { servers: [], idleTimeoutMinutes: 0 },
  });
  assert.equal(disabledTimeout.lsp?.idleTimeoutMinutes, 0);
});

test("LSP configuration rejects invalid server entries", () => {
  const validServer = {
    extensions: [".ts"],
    languageIds: { ".ts": "typescript" },
    command: ["server"],
  };
  const withServer = (server: unknown): unknown => ({
    ...validConfig() as object,
    lsp: { servers: [server] },
  });

  const invalidServers: readonly unknown[] = [
    { ...validServer, extensions: [] },
    { ...validServer, command: [] },
    { ...validServer, extensions: [""] },
    { ...validServer, extensions: ["ts"], languageIds: { ts: "typescript" } },
    { ...validServer, extensions: [".ts/x"], languageIds: { ".ts/x": "typescript" } },
    { ...validServer, command: [""] },
    { ...validServer, args: [] },
    { extensions: [".ts"], command: ["server"] },
    { ...validServer, languageIds: {} },
    { ...validServer, languageIds: { ".ts": "typescript", ".tsx": "typescriptreact" } },
    { ...validServer, languageIds: { ".ts": "" } },
    { ...validServer, languageIds: [] },
  ];
  for (const server of invalidServers) {
    assert.throws(() => parseExtensionConfig(withServer(server)), /Invalid policy configuration/);
  }
});

test("LSP configuration rejects duplicate extensions, invalid timeouts, and extra keys", () => {
  for (const servers of [
    [{ extensions: [".ts", ".ts"], languageIds: { ".ts": "typescript" }, command: ["server"] }],
    [
      { extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["first-server"] },
      { extensions: [".ts"], languageIds: { ".ts": "typescript" }, command: ["second-server"] },
    ],
  ]) {
    assert.throws(() => parseExtensionConfig({
      ...validConfig() as object,
      lsp: { servers },
    }), /duplicate extension \.ts/);
  }

  for (const idleTimeoutMinutes of [-1, 35_792, "15", null, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseExtensionConfig({
      ...validConfig() as object,
      lsp: { servers: [], idleTimeoutMinutes },
    }), /idleTimeoutMinutes/);
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
