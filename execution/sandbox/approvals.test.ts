import assert from "node:assert/strict";
import test from "node:test";
import { SessionApprovals } from "./approvals.ts";

test("concurrent requests share one approval message", async () => {
  let approve!: (approved: boolean) => void;
  const confirmation = new Promise<boolean>((resolve) => { approve = resolve; });
  const messages: string[] = [];
  const approvals = new SessionApprovals({
    hasUI: true,
    confirm: () => confirmation,
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
  assert.deepEqual(messages, ["User approved network access: registry.npmjs.org:443"]);
});
