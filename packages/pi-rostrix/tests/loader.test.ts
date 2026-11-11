import test, { describe } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parseProfileMarkdown, parseProfileJson, ProfileParseError } from "../src/loader/parser.ts";
import { discoverAllProfiles, scanDirectory } from "../src/loader/discovery.ts";

describe("Profile Parser", () => {
  test("parseProfileMarkdown - table-driven cases", () => {
    const cases = [
      {
        name: "standard frontmatter and body",
        content: `---
id: custom-analyst
label: Custom Analyst
description: Log analysis specialist
tools:
  allow: [read, grep]
model:
  preferred: anthropic/claude-sonnet-4-5
---
You are an expert analyst.
Guidelines:
- Analyze logs carefully.
`,
        options: {},
        expected: {
          id: "custom-analyst",
          label: "Custom Analyst",
          description: "Log analysis specialist",
          prompt: {
            systemPrompt: "You are an expert analyst.\nGuidelines:\n- Analyze logs carefully.",
          },
          tools: { allow: ["read", "grep"] },
          model: { preferred: "anthropic/claude-sonnet-4-5" },
        },
      },
      {
        name: "omitted id/label/description falls back to file stem",
        content: `---
tools:
  allow: [read]
---
Focus only on reviewing.
`,
        options: { fallbackId: "reviewer-from-filename" },
        expected: {
          id: "reviewer-from-filename",
          label: "reviewer-from-filename",
          description: "reviewer-from-filename",
          prompt: {
            systemPrompt: "Focus only on reviewing.",
          },
          tools: { allow: ["read"] },
        },
      },
      {
        name: "pure markdown without frontmatter",
        content: "You are a minimal assistant.",
        options: { fallbackId: "minimal-bot" },
        expected: {
          id: "minimal-bot",
          label: "minimal-bot",
          description: "minimal-bot",
          prompt: {
            systemPrompt: "You are a minimal assistant.",
          },
        },
      },
    ];

    for (const c of cases) {
      const result = parseProfileMarkdown(c.content, c.options);
      assert.equal(result.id, c.expected.id, `[${c.name}] id mismatch`);
      assert.equal(result.label, c.expected.label, `[${c.name}] label mismatch`);
      assert.equal(result.description, c.expected.description, `[${c.name}] description mismatch`);
      assert.equal(result.prompt?.systemPrompt, c.expected.prompt?.systemPrompt, `[${c.name}] prompt mismatch`);
      if (c.expected.tools) {
        assert.deepEqual(result.tools, c.expected.tools, `[${c.name}] tools mismatch`);
      }
    }
  });

  test("parseProfileMarkdown - rejects invalid YAML or schema errors", () => {
    assert.throws(
      () => parseProfileMarkdown("--- \n[malformed yaml :::: \n--- \nbody"),
      (err: unknown) => err instanceof ProfileParseError && err.message.includes("Failed to parse YAML frontmatter"),
    );

    assert.throws(
      () => parseProfileMarkdown(`---
id: invalid-profile
tools:
  allow: 12345
---
body`),
      (err: unknown) => err instanceof ProfileParseError && err.message.includes("Validation failed"),
    );
  });

  test("parseProfileJson - parses valid JSON and rejects invalid", () => {
    const validJson = JSON.stringify({
      id: "json-agent",
      label: "JSON Agent",
      description: "Declared via JSON",
      tools: { allow: ["find", "grep"] },
    });

    const parsed = parseProfileJson(validJson);
    assert.equal(parsed.id, "json-agent");
    assert.deepEqual(parsed.tools?.allow, ["find", "grep"]);

    assert.throws(
      () => parseProfileJson("{ bad json }"),
      (err: unknown) => err instanceof ProfileParseError && err.message.includes("Failed to parse JSON"),
    );

    assert.throws(
      () => parseProfileJson(JSON.stringify({ id: "agent", tools: { allow: false } })),
      (err: unknown) => err instanceof ProfileParseError && err.message.includes("Validation failed"),
    );
  });
});

describe("Profile Discovery", () => {
  let tempDir: string;

  test("discovers files and respects precedence (project > user)", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "rostrix-loader-test-"));
    const userDir = path.join(tempDir, "user", "profiles");
    const projectDir = path.join(tempDir, "project", "profiles");

    await fs.mkdir(userDir, { recursive: true });
    await fs.mkdir(projectDir, { recursive: true });

    // 1. User profile A
    await fs.writeFile(
      path.join(userDir, "agent-a.md"),
      `---
label: User Agent A
---
User agent A prompt.`,
    );

    // 2. User profile Shared (will be overridden by project)
    await fs.writeFile(
      path.join(userDir, "shared.md"),
      `---
id: shared-agent
label: Global Shared
---
Global prompt.`,
    );

    // 3. Project profile Shared (overrides User profile Shared)
    await fs.writeFile(
      path.join(projectDir, "shared.md"),
      `---
id: shared-agent
label: Project Shared Override
---
Project prompt override.`,
    );

    // 4. Project profile B (.json)
    await fs.writeFile(
      path.join(projectDir, "agent-b.json"),
      JSON.stringify({
        id: "project-b",
        label: "Project B",
        description: "Project only",
      }),
    );

    // 5. Malformed file (should produce error in discovery result without crashing)
    await fs.writeFile(path.join(projectDir, "corrupted.md"), "--- \n[invalid yaml \n---");

    const warnings: string[] = [];
    const result = await discoverAllProfiles({
      userDir,
      projectDir,
      onWarning: (w) => warnings.push(w),
    });

    assert.equal(result.profiles.length, 3, "Should discover 3 unique profiles");
    assert.equal(result.errors.length, 1, "Should record 1 corrupted file error");
    assert.equal(warnings.length, 1);

    const shared = result.profiles.find((p) => p.profile.id === "shared-agent");
    assert.ok(shared);
    assert.equal(shared.profile.label, "Project Shared Override");
    assert.equal(shared.scope, "project");

    const userA = result.profiles.find((p) => p.profile.id === "agent-a");
    assert.ok(userA);
    assert.equal(userA.scope, "user");

    const projectB = result.profiles.find((p) => p.profile.id === "project-b");
    assert.ok(projectB);
    assert.equal(projectB.scope, "project");

    // Cleanup
    await fs.rm(tempDir, { recursive: true, force: true });
  });
});
