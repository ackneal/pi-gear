import assert from "node:assert/strict";
import test from "node:test";
import {
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";

// A regular file cannot have children, so this cwd cannot exist on any run.
const nonexistentCwd = `${import.meta.filename}/nonexistent-cwd`;
const command = "printf 'native contract'";

test("native local Bash rejects invalid timeouts before cwd access or spawn", async (t) => {
  const cases = [
    { name: "zero", timeout: 0, message: "Invalid timeout: must be a finite number of seconds" },
    { name: "negative", timeout: -1, message: "Invalid timeout: must be a finite number of seconds" },
    { name: "NaN", timeout: NaN, message: "Invalid timeout: must be a finite number of seconds" },
    { name: "Infinity", timeout: Infinity, message: "Invalid timeout: must be a finite number of seconds" },
    { name: "above timer limit", timeout: 2147483647 / 1000 + 1, message: "Invalid timeout: maximum is 2147483.647 seconds" },
  ];

  for (const row of cases) {
    await t.test(row.name, async () => {
      const operations = createLocalBashOperations();

      await assert.rejects(
        operations.exec(command, nonexistentCwd, {
          timeout: row.timeout,
          onData: () => assert.fail("invalid timeout must not produce shell output"),
        }),
        { name: "Error", message: row.message },
      );
    });
  }
});

test("native Bash definition forwards execution options and maps streamed outcomes", async (t) => {
  const cases = [
    { name: "nonzero exit", timeout: 1.25, exitCode: 7, error: undefined, expected: "partial output\n\nCommand exited with code 7" },
    { name: "aborted", timeout: undefined, exitCode: 0, error: "aborted", expected: "partial output\n\nCommand aborted" },
    { name: "timeout", timeout: 2.5, exitCode: 0, error: "timeout:2.5", expected: "partial output\n\nCommand timed out after 2.5 seconds" },
  ];

  for (const row of cases) {
    await t.test(row.name, async () => {
      const controller = new AbortController();
      let calls = 0;
      const operations: BashOperations = {
        async exec(actualCommand, cwd, options) {
          calls++;
          assert.equal(actualCommand, command);
          assert.equal(cwd, nonexistentCwd);
          assert.equal(options.timeout, row.timeout);
          assert.equal(options.signal, controller.signal);
          options.onData(Buffer.from("partial output"));
          if (row.error !== undefined) throw new Error(row.error);
          return { exitCode: row.exitCode };
        },
      };
      // Session services are intentionally unavailable: this contract needs only cwd.
      const context = new Proxy({ cwd: nonexistentCwd } as ExtensionToolContext, {
        get(target, key) {
          assert.equal(key, "cwd", "must not access session services");
          return target.cwd;
        },
      });
      const tool = createBashToolDefinition(nonexistentCwd, {
        operations,
        exposeSessionEnvironment: false,
      });
      const updates: string[] = [];

      const execution = tool.execute(
        "native-contract",
        { command, ...(row.timeout === undefined ? {} : { timeout: row.timeout }) },
        controller.signal,
        (update) => {
          for (const content of update.content) {
            if (content.type === "text") updates.push(content.text);
          }
        },
        context,
      );

      if (row.error !== undefined) {
        await assert.rejects(execution, { name: "Error", message: row.expected });
      } else {
        const result = await execution;
        assert.equal(result.isError, true);
        const structured = result.structuredContent;
        assert.ok(structured !== null && typeof structured === "object");
        assert.ok("exit_code" in structured && "output" in structured);
        assert.equal(structured.exit_code, row.exitCode);
        assert.equal(structured.output, "partial output");
        assert.deepEqual(result.content, [{ type: "text", text: row.expected }]);
      }
      assert.equal(calls, 1);
      assert.ok(updates.includes("partial output"));
    });
  }
});
