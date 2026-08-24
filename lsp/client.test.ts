import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LspClient } from "./client.ts";

const fakeServer = String.raw`
import { appendFileSync } from "node:fs";
const log = process.argv[2];
appendFileSync(log, "start\n");
let buffer = Buffer.alloc(0);
const send = (message) => {
  const body = JSON.stringify(message);
  process.stdout.write("Content-Length: " + Buffer.byteLength(body) + "\r\n\r\n" + body);
};
let initializeId;
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const match = buffer.subarray(0, end).toString().match(/Content-Length:\s*(\d+)/i);
    const length = Number(match?.[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString());
    buffer = buffer.subarray(end + 4 + length);
    if (message.method === "initialize") {
      initializeId = message.id;
      send({ jsonrpc: "2.0", id: message.id, method: "workspace/configuration", params: { items: [] } });
    } else if (message.id === initializeId && Array.isArray(message.result)) {
      appendFileSync(log, "server-request-response\n");
      send({ jsonrpc: "2.0", id: initializeId, result: { capabilities: {} } });
    }
    if (message.method === "textDocument/didOpen" || message.method === "textDocument/didChange") {
      const uri = message.params.textDocument.uri;
      appendFileSync(log, message.method + "\n");
      send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: new URL("other.ts", uri).href, diagnostics: [] } });
      setTimeout(() => send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics: [{ range: { start: { line: 1, character: 2 }, end: { line: 1, character: 3 } }, severity: 1, code: "E1", message: "broken" }] } }), 25);
    }
    if (message.method === "textDocument/definition" || message.method === "textDocument/references") {
      appendFileSync(log, message.method + ":" + message.params.position.line + ":" + message.params.position.character + "\n");
      send({ jsonrpc: "2.0", id: message.id, result: [{ uri: message.params.textDocument.uri, range: { start: { line: 3, character: 4 }, end: { line: 3, character: 5 } } }] });
    }
    if (message.method === "shutdown") {
      appendFileSync(log, "shutdown\n");
      send({ jsonrpc: "2.0", id: message.id, result: null });
    }
    if (message.method === "exit") process.exit(0);
  }
});
`;

test("LSP client starts lazily, reuses one process, navigates, and shuts down", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-gear-lsp-client-"));
  const script = join(cwd, "server.mjs");
  const log = join(cwd, "server.log");
  const source = join(cwd, "source.ts");
  await writeFile(script, fakeServer);
  await writeFile(source, "const broken = true;\n");
  const client = new LspClient({ extensions: [".ts"], command: [process.execPath, script, log] }, cwd);

  try {
    await assert.rejects(readFile(log, "utf8"));
    await client.sync(source);
    await client.waitForDiagnostics(source, 0, 1_000);
    assert.equal(client.diagnosticsFor(source)[0]?.message, "broken");

    await client.sync(source);
    const definitions = await client.navigate("textDocument/definition", source, { line: 0, character: 1 }) as unknown[];
    const references = await client.navigate("textDocument/references", source, { line: 2, character: 3 }) as unknown[];
    assert.equal(definitions.length, 1);
    assert.equal(references.length, 1);

    await client.shutdown();
    const events = await readFile(log, "utf8");
    assert.equal(events.match(/^start$/gm)?.length, 1);
    assert.match(events, /server-request-response/);
    assert.equal(events.match(/textDocument\/didOpen/g)?.length, 1);
    assert.ok((events.match(/textDocument\/didChange/g)?.length ?? 0) >= 1);
    assert.match(events, /textDocument\/definition:0:1/);
    assert.match(events, /textDocument\/references:2:3/);
    assert.match(events, /shutdown/);
  } finally {
    await client.shutdown();
    await rm(cwd, { recursive: true, force: true });
  }
});
