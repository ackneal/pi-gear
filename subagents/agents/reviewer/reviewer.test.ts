import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { childArgs, withoutWorkspaceSearch } from "../../runtime/process.ts";
import type { SubagentRun } from "../../runtime/types.ts";
import {
  formatReviewerInput,
  REVIEWER_TOOL_NAME,
  runReviewer,
  type ReviewerSubagentInput,
} from "./index.ts";
import { REVIEWER_CAPABILITIES, reviewerProfile } from "./profile.ts";
import { REVIEWER_SYSTEM_PROMPT } from "./prompt.ts";

test("reviewer profile, prompt, and capabilities match specification", () => {
  assert.equal(REVIEWER_TOOL_NAME, "reviewer");
  assert.equal(reviewerProfile.id, "reviewer");
  assert.equal(reviewerProfile.label, "reviewer");
  assert.equal(reviewerProfile.description, "Delegate focused read-only code review.");
  assert.equal(reviewerProfile.systemPrompt, REVIEWER_SYSTEM_PROMPT);
  assert.match(REVIEWER_SYSTEM_PROMPT, /only the requested scope/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /direct callers, callees, and shared contracts/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /confirmed issues from unverified risks/);
  assert.match(REVIEWER_SYSTEM_PROMPT, /Do not modify project files/);
  assert.deepEqual(reviewerProfile.capabilities, REVIEWER_CAPABILITIES);
  assert.deepEqual(REVIEWER_CAPABILITIES, [
    { kind: "builtin", name: "read" },
    { kind: "builtin", name: "find" },
    { kind: "builtin", name: "grep" },
    { kind: "builtin", name: "bash" },
  ]);
  assert.deepEqual(reviewerProfile.presentation, {
    activity: {
      starting: "Reviewing",
      complete: "Review complete",
      drafting: "Drafting review",
      failed: "Review failed",
      aborted: "Review aborted",
    },
  });
});

test("reviewer child arguments configure isolation, read-only capabilities, and system prompt", () => {
  const extensionUrl = new URL("../../../index.ts", import.meta.url);
  const args = childArgs(reviewerProfile, "review diff", extensionUrl);
  assert.ok(
    args.includes("--no-session") &&
    args.includes("--no-skills") &&
    args.includes("--no-context-files") &&
    args.includes("--no-prompt-templates"),
  );
  assert.equal(args[args.indexOf("--tools") + 1], "read,find,grep,bash");
  assert.equal(args[args.indexOf("--system-prompt") + 1], REVIEWER_SYSTEM_PROMPT);
  assert.equal(args.filter((arg) => arg === "--extension").length, 1);
  assert.equal(args[args.indexOf("--extension") + 1], extensionUrl.pathname);
  assert.equal(args[args.length - 1], "review diff");

  const withoutSearch = withoutWorkspaceSearch(reviewerProfile);
  const argsWithoutSearch = childArgs(withoutSearch, "review diff", extensionUrl);
  assert.equal(argsWithoutSearch[argsWithoutSearch.indexOf("--tools") + 1], "read,bash");
});

test("formatReviewerInput serializes structured review input, omitting absent optional sections", () => {
  const cases: { input: ReviewerSubagentInput; expected: string }[] = [
    {
      input: { scope: "uncommitted changes", context: undefined, skills: undefined },
      expected: "Scope: uncommitted changes",
    },
    {
      input: {
        scope: "subagents/",
        context: "add reviewer subagent",
        skills: ["/path/to/coding-principles/SKILL.md"],
      },
      expected: "Scope: subagents/\nContext: add reviewer subagent\nSkills:\n- /path/to/coding-principles/SKILL.md",
    },
  ];
  for (const { input, expected } of cases) {
    assert.equal(formatReviewerInput(input), expected);
  }
});

test("runReviewer executes via child runner with reviewer profile and emits updates", async () => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => true,
  });

  const updates: SubagentRun[] = [];
  const brief = formatReviewerInput({
    scope: "uncommitted changes",
    context: "add reviewer",
    skills: undefined,
  });
  const promise = runReviewer(brief, {
    cwd: "/workspace",
    spawnChild: () => child as never,
    onUpdate: (update: SubagentRun) => {
      updates.push(update);
    },
  });

  child.stdout.emit(
    "data",
    Buffer.from('{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"No issues found."}]}}\n'),
  );
  child.emit("close", 0);

  const result = await promise;
  assert.equal(result.status, "success");
  assert.equal(result.result, "No issues found.");
  assert.ok(updates.length > 0);
});
