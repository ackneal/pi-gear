import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpCapabilitySpec } from "./types.ts";

export type RemoteTool = { name: string; description?: string | undefined; inputSchema: { type: "object"; properties?: Record<string, object> | undefined; required?: string[] | undefined }; title?: string | undefined };
export type ConnectedMcpCapability = { spec: McpCapabilitySpec; client: Client; tools: RemoteTool[] };
const CONNECT_TIMEOUT_MS = 10_000;

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${CONNECT_TIMEOUT_MS}ms`)), CONNECT_TIMEOUT_MS);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
  });
}

export async function connectMcpCapability(spec: McpCapabilitySpec): Promise<ConnectedMcpCapability> {
  const client = new Client({ name: "pi-gear-research-bridge", version: "1.0.0" });
  try {
    await withTimeout(client.connect(new StreamableHTTPClientTransport(new URL(spec.endpoint)) as unknown as Transport), `${spec.id} connect`);
    const listed = await withTimeout(client.listTools(), `${spec.id} listTools`);
    const allowed = new Set(spec.tools.map((tool) => tool.name));
    const tools = listed.tools.filter((tool) => allowed.has(tool.name)) as RemoteTool[];
    if (!tools.length) throw new Error("no supported tools advertised");
    return { spec, client, tools };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
