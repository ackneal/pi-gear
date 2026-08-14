import assert from "node:assert/strict";
import test from "node:test";
import type { AccessPolicy } from "../../config/types.ts";
import { evaluateNetwork } from "./network.ts";

const policy: AccessPolicy = {
  filesystem: { workspaceDefault: "read-write", outsideWorkspaceDefault: "ask", rules: [] },
  network: { defaultAccess: "ask", rules: [
    { host: "api.example.com:443", access: "allow" },
    { host: "*.example.com", access: "allow" },
    { host: "blocked.example.com", access: "deny" },
  ] },
};

test("network policy honors exact and wildcard hosts, deny precedence, and unknown asks", () => {
  assert.equal(evaluateNetwork(policy, "api.example.com", 443), "allow");
  assert.equal(evaluateNetwork(policy, "api.example.com", 80), "allow");
  assert.equal(evaluateNetwork(policy, "www.example.com"), "allow");
  assert.equal(evaluateNetwork(policy, "example.com"), "ask");
  assert.equal(evaluateNetwork(policy, "blocked.example.com"), "deny");
  assert.equal(evaluateNetwork(policy, "unknown.example.net"), "ask");
});
