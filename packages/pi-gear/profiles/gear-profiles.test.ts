import assert from "node:assert/strict";
import test from "node:test";
import { ALL_GEAR_PROFILES, GEAR_WORKER_PROFILE, GEAR_RESEARCHER_PROFILE, GEAR_REVIEWER_PROFILE } from "./gear-profiles.ts";
import { ProfileRegistry, ProfileResolver } from "pi-rostrix";

test("Gear profiles are valid and can be registered and resolved by Rostrix", () => {
  const registry = new ProfileRegistry();

  for (const profile of ALL_GEAR_PROFILES) {
    registry.register(profile);
  }

  assert.equal(registry.list().length, 3);

  const resolver = new ProfileResolver(registry);
  const resolvedWorker = resolver.resolve("gear:worker");
  assert.equal(resolvedWorker.id, "gear:worker");
  assert.ok(resolvedWorker.allowedTools?.includes("read"));
  assert.ok(resolvedWorker.allowedTools?.includes("edit"));

  const resolvedReviewer = resolver.resolve("gear:reviewer");
  assert.equal(resolvedReviewer.id, "gear:reviewer");
  assert.ok(resolvedReviewer.deniedTools.includes("edit"));
  assert.ok(resolvedReviewer.deniedTools.includes("write"));

  const resolvedResearcher = resolver.resolve("gear:researcher");
  assert.equal(resolvedResearcher.id, "gear:researcher");
});
