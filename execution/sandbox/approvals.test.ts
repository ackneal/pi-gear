import assert from "node:assert/strict";
import test from "node:test";
import { SessionApprovals } from "./approvals.ts";

for (const scenario of [
  {
    name: "concurrent requests share one approval notification",
    choice: "once" as const,
    host: "registry.npmjs.org",
    port: 443,
    expectedNotification: ["User approved network access: registry.npmjs.org:443", "info"] as const,
    expectedResult: true,
  },
  {
    name: "concurrent requests share one permanent approval notification",
    choice: "always" as const,
    host: "dl.google.com",
    port: 443,
    expectedNotification: ["User permanently approved network access: dl.google.com", "info"] as const,
    expectedResult: true,
  },
  {
    name: "concurrent requests share one denial notification",
    choice: "deny" as const,
    host: "dl.google.com",
    port: 443,
    expectedNotification: ["User denied network access: dl.google.com:443", "warning"] as const,
    expectedResult: false,
  },
]) {
  test(scenario.name, async () => {
    let approve!: (choice: "once" | "always" | "deny") => void;
    const confirmation = new Promise<"once" | "always" | "deny">((resolve) => { approve = resolve; });
    const notifications: Array<[string, string]> = [];
    const persisted: string[] = [];
    const approvals = new SessionApprovals({
      hasUI: true,
      promptNetwork: () => confirmation,
      notify: (message, level) => { notifications.push([message, level]); },
      persistAllowedHost: async (host) => { persisted.push(host); },
    }, () => true);
    const request = { host: scenario.host, port: scenario.port };

    const results = Promise.all([
      approvals.requestNetwork(request),
      approvals.requestNetwork(request),
      approvals.requestNetwork(request),
    ]);
    approve(scenario.choice);

    assert.deepEqual(await results, [scenario.expectedResult, scenario.expectedResult, scenario.expectedResult]);
    assert.deepEqual(notifications, [scenario.expectedNotification]);
    if (scenario.choice === "always") assert.deepEqual(persisted, [scenario.host.toLowerCase()]);
    assert.equal(approvals.pendingHostPrompts.size, 0);
  });
}

for (const scenario of [
  {
    name: "approval is cached case-insensitively per port",
    hasUI: true,
    current: true,
    choice: "once" as const,
    expire: false,
    requests: [{ host: "EXAMPLE.com", port: 443 }, { host: "example.com", port: 443 }, { host: "example.com", port: 80 }],
    results: [true, true, true],
    prompts: 2,
    levels: ["info", "info"],
    cached: ["example.com:443", "example.com:80"],
    permanentlyCached: [],
    persisted: [],
  },
  {
    name: "always approval persists host and allows all ports without re-prompting",
    hasUI: true,
    current: true,
    choice: "always" as const,
    expire: false,
    requests: [{ host: "DL.Google.COM", port: 443 }, { host: "dl.google.com", port: 80 }],
    results: [true, true],
    prompts: 1,
    levels: ["info"],
    cached: ["dl.google.com:443"],
    permanentlyCached: ["dl.google.com"],
    persisted: ["dl.google.com"],
  },
  {
    name: "persistence failure warns but permits access in current session",
    hasUI: true,
    current: true,
    choice: "always" as const,
    persistError: new Error("disk full"),
    expire: false,
    requests: [{ host: "dl.google.com", port: 443 }],
    results: [true],
    prompts: 1,
    levels: ["warning", "info"],
    cached: ["dl.google.com:443"],
    permanentlyCached: ["dl.google.com"],
    persisted: [],
  },
  {
    name: "denial warns and is not cached",
    hasUI: true,
    current: true,
    choice: "deny" as const,
    expire: false,
    requests: [{ host: "example.com", port: undefined }, { host: "example.com", port: undefined }],
    results: [false, false],
    prompts: 2,
    levels: ["warning", "warning"],
    cached: [],
    permanentlyCached: [],
    persisted: [],
  },
  {
    name: "headless requests are denied without prompting",
    hasUI: false,
    current: true,
    choice: "once" as const,
    expire: false,
    requests: [{ host: "example.com", port: undefined }],
    results: [false],
    prompts: 0,
    levels: [],
    cached: [],
    permanentlyCached: [],
    persisted: [],
  },
  {
    name: "stale requests are denied without prompting",
    hasUI: true,
    current: false,
    choice: "once" as const,
    expire: false,
    requests: [{ host: "example.com", port: undefined }],
    results: [false],
    prompts: 0,
    levels: [],
    cached: [],
    permanentlyCached: [],
    persisted: [],
  },
  {
    name: "approval after session expiry is not cached or notified",
    hasUI: true,
    current: true,
    choice: "once" as const,
    expire: true,
    requests: [{ host: "example.com", port: undefined }],
    results: [false],
    prompts: 1,
    levels: [],
    cached: [],
    permanentlyCached: [],
    persisted: [],
  },
]) {
  test(scenario.name, async () => {
    let current = scenario.current;
    let prompts = 0;
    const notifications: Array<[string, string]> = [];
    const persisted: string[] = [];
    const approvals = new SessionApprovals({
      hasUI: scenario.hasUI,
      promptNetwork: async () => {
        prompts += 1;
        if (scenario.expire) current = false;
        return scenario.choice;
      },
      notify: (message, level) => { notifications.push([message, level]); },
      persistAllowedHost: async (host) => {
        if (scenario.persistError) throw scenario.persistError;
        persisted.push(host);
      },
    }, () => current);

    const results = [];
    for (const request of scenario.requests) results.push(await approvals.requestNetwork(request));

    assert.deepEqual(results, scenario.results);
    assert.equal(prompts, scenario.prompts);
    assert.deepEqual(notifications.map(([, level]) => level), scenario.levels);
    assert.deepEqual([...approvals.approvedHosts], scenario.cached);
    assert.deepEqual([...approvals.permanentlyApprovedHosts], scenario.permanentlyCached);
    assert.deepEqual(persisted, scenario.persisted);
    assert.equal(approvals.pendingHostPrompts.size, 0);

    approvals.clear();
    assert.equal(approvals.approvedHosts.size, 0);
    assert.equal(approvals.permanentlyApprovedHosts.size, 0);
    assert.equal(approvals.pendingHostPrompts.size, 0);
  });
}
