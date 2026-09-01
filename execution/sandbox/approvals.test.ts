import assert from "node:assert/strict";
import test from "node:test";
import { SessionApprovals } from "./approvals.ts";

test("concurrent requests share one approval message", async () => {
  let approve!: (approved: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => { approve = resolve; });
  const messages: string[] = [];
  let promptMessage: string | undefined;
  const approvals = new SessionApprovals({
    hasUI: true,
    confirm: (_title, message) => { promptMessage = message; return confirmation; },
    notify: () => undefined,
    sendMessage: (message) => { messages.push(message); },
  }, () => true);
  const request = { host: "registry.npmjs.org", port: 443 };

  const results = Promise.all([
    approvals.requestNetwork(request),
    approvals.requestNetwork(request),
    approvals.requestNetwork(request),
  ]);
  approve(true);

  assert.deepEqual(await results, [true, true, true]);
  assert.equal(promptMessage, "Allow bash to connect to registry.npmjs.org:443?");
  assert.deepEqual(messages, ["User approved network access: registry.npmjs.org:443"]);
});
