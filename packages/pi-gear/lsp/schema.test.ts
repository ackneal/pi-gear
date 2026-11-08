import assert from "node:assert/strict";
import test from "node:test";
import { parseNavigationResponse, parsePublishDiagnostics, SUPPORTED_LSP_VERSION } from "./schema.ts";

const range = {
  start: { line: 0, character: 1 },
  end: { line: 0, character: 2 },
};

test("LSP 3.17 diagnostics parser accepts the supported standard subset", () => {
  assert.equal(SUPPORTED_LSP_VERSION, "3.17");
  assert.deepEqual(parsePublishDiagnostics({
    uri: "file:///workspace/source.ts",
    version: 1,
    diagnostics: [{ range, severity: 1, code: 2322, source: "typescript", message: "broken", data: null }],
  }), {
    uri: "file:///workspace/source.ts",
    diagnostics: [{ range, severity: 1, code: 2322, source: "typescript", message: "broken" }],
  });
});

test("LSP 3.17 diagnostics parser reports the invalid field path", () => {
  assert.throws(() => parsePublishDiagnostics({
    uri: "file:///workspace/source.ts",
    diagnostics: [{ range: { ...range, start: { line: -1, character: 0 } }, message: "broken" }],
  }), /Invalid LSP 3\.17 payload: publishDiagnostics\.params\.diagnostics\[0\]\.range\.start\.line must be an unsigned 32-bit integer/);
});

test("LSP 3.17 navigation parser accepts each response shape used by definition and references", () => {
  const location = { uri: "file:///workspace/source.ts", range };
  const link = { targetUri: "file:///workspace/target.ts", targetRange: range, targetSelectionRange: range };

  assert.deepEqual(parseNavigationResponse("definition", null), []);
  assert.deepEqual(parseNavigationResponse("definition", location), [location]);
  assert.deepEqual(parseNavigationResponse("definition", [link]), [link]);
  assert.deepEqual(parseNavigationResponse("references", [location]), [location]);
  assert.throws(
    () => parseNavigationResponse("references", location),
    /references\.result must be an array of Location objects or null/,
  );
  assert.throws(
    () => parseNavigationResponse("definition", [location, link]),
    /definition\.result\[1\]\.uri must be a string/,
  );
});
