import assert from "node:assert/strict";
import test from "node:test";
import { SessionApprovals } from "./approvals.ts";

for (const scenario of [
  {
    name: "concurrent requests share one approval notification",
    approved: true,
    host: "registry.npmjs.org",
    port: 443,
    expectedNotification: ["User approved network access: registry.npmjs.org:443", "info"] as const,
    expectedResult: true,
  },
  {
    name: "concurrent requests share one denial notification",
    approved: false,
    host: "dl.google.com",
    port: 443,
    expectedNotification: ["User denied network access: dl.google.com:443", "warning"] as const,
    expectedResult: false,
  },
]) {
  test(scenario.name, async () => {
    let approve!: (approved: boolean) => void;
    const confirmation = new Promise<boolean>((resolve) => { approve = resolve; });
    const notifications: Array<[string, string]> = [];
    let promptMessage: string | undefined;
    const approvals = new SessionApprovals({
      hasUI: true,
      confirm: (_title, message) => { promptMessage = message; return confirmation; },
      notify: (message, level) => { notifications.push([message, level]); },
    }, () => true);
    const request = { host: scenario.host, port: scenario.port };

    const results = Promise.all([
      approvals.requestNetwork(request),
      approvals.requestNetwork(request),
      approvals.requestNetwork(request),
    ]);
    approve(scenario.approved);

    assert.deepEqual(await results, [scenario.expectedResult, scenario.expectedResult, scenario.expectedResult]);
    assert.equal(promptMessage, `Allow bash to connect to ${scenario.host}:${scenario.port}?`);
    assert.deepEqual(notifications, [scenario.expectedNotification]);
    assert.equal(approvals.pendingHostPrompts.size, 0);
  });
}

for (const scenario of [
  { name: "approval is cached case-insensitively per port", hasUI: true, current: true, approved: true, expire: false, requests: [{ host: "EXAMPLE.com", port: 443 }, { host: "example.com", port: 443 }, { host: "example.com", port: 80 }], results: [true, true, true], prompts: 2, levels: ["info", "info"], cached: ["example.com:443", "example.com:80"] },
  { name: "denial warns and is not cached", hasUI: true, current: true, approved: false, expire: false, requests: [{ host: "example.com", port: undefined }, { host: "example.com", port: undefined }], results: [false, false], prompts: 2, levels: ["warning", "warning"], cached: [] },
  { name: "headless requests are denied without prompting", hasUI: false, current: true, approved: true, expire: false, requests: [{ host: "example.com", port: undefined }], results: [false], prompts: 0, levels: [], cached: [] },
  { name: "stale requests are denied without prompting", hasUI: true, current: false, approved: true, expire: false, requests: [{ host: "example.com", port: undefined }], results: [false], prompts: 0, levels: [], cached: [] },
  { name: "approval after session expiry is not cached or notified", hasUI: true, current: true, approved: true, expire: true, requests: [{ host: "example.com", port: undefined }], results: [false], prompts: 1, levels: [], cached: [] },
]) {
  test(scenario.name, async () => {
    let current = scenario.current;
    let prompts = 0;
    const notifications: Array<[string, string]> = [];
    const approvals = new SessionApprovals({
      hasUI: scenario.hasUI,
      confirm: async () => {
        prompts += 1;
        if (scenario.expire) current = false;
        return scenario.approved;
      },
      notify: (message, level) => { notifications.push([message, level]); },
    }, () => current);

    const results = [];
    for (const request of scenario.requests) results.push(await approvals.requestNetwork(request));

    assert.deepEqual(results, scenario.results);
    assert.equal(prompts, scenario.prompts);
    assert.deepEqual(notifications.map(([, level]) => level), scenario.levels);
    assert.deepEqual([...approvals.approvedHosts], scenario.cached);
    assert.equal(approvals.pendingHostPrompts.size, 0);
    if (!scenario.approved) {
      assert.deepEqual(notifications.map(([message]) => message), scenario.requests.map(() => "User denied network access: example.com:unknown"));
    }
    approvals.clear();
    assert.equal(approvals.approvedHosts.size, 0);
    assert.equal(approvals.pendingHostPrompts.size, 0);
  });
}
