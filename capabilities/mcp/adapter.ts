import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { connectMcpCapability, type ConnectedMcpCapability } from "./client.ts";
import { bridgeToolName } from "./specs.ts";
import type { McpCapabilitySpec } from "./types.ts";

const MAX_MCP_TEXT_CHARS = 16_000;

const truncateMcpText = (text: string): string => text.length > MAX_MCP_TEXT_CHARS
  ? `${text.slice(0, MAX_MCP_TEXT_CHARS - 12)}\n[truncated]`
  : text;

function textResult(content: unknown): string {
  if (!Array.isArray(content)) return "";

  const text = content
    .filter((item): item is { type: unknown; text: unknown } => typeof item === "object" && item !== null)
    .filter((item) => item.type === "text" && typeof item.text === "string")
    .map((item) => item.text as string)
    .join("\n");

  return truncateMcpText(text);
}

function label(id: string, tool: { name: string; title?: string | undefined }): string {
  const displayId = id.replace(/[_-]/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  return `${displayId}: ${tool.title ?? tool.name}`;
}

function reportRemoteFailure(result: PromiseSettledResult<ConnectedMcpCapability>): void {
  if (result.status === "rejected") {
    const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
    console.error(`[researcher] remote unavailable: ${reason}`);
  }
}

function registerRemoteTools(pi: ExtensionAPI, remote: ConnectedMcpCapability): void {
  for (const tool of remote.tools) {
    pi.registerTool({
      name: bridgeToolName(remote.spec.id, tool.name),
      label: label(remote.spec.id, tool),
      description: tool.description ?? `Call ${tool.name} on ${remote.spec.id}.`,
      parameters: Type.Unsafe<Record<string, unknown>>(tool.inputSchema as TSchema),
      async execute(_id, args, signal) {
        try {
          const result = await remote.client.callTool(
            { name: tool.name, arguments: args },
            undefined,
            signal ? { signal } : undefined,
          );
          const text = textResult(result.content);
          return {
            content: [{ type: "text", text: text || "The MCP tool returned no text content." }],
            details: { isError: result.isError === true },
            ...(result.isError === true ? { isError: true } : {}),
          };
        } catch (error) {
          return {
            content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
            details: { isError: true },
            isError: true,
          };
        }
      },
    });
  }
}

/** Connects each fixed remote independently so one provider cannot remove the others. */
export async function setupMcpCapabilities(pi: ExtensionAPI, specs: readonly McpCapabilitySpec[]): Promise<void> {
  const results = await Promise.allSettled(specs.map(connectMcpCapability));
  const connected = results.flatMap((result) => {
    reportRemoteFailure(result);
    return result.status === "fulfilled" ? [result.value] : [];
  });

  let closed = false;
  const closeAll = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await Promise.allSettled(connected.map(({ client }) => client.close()));
  };

  for (const remote of connected) registerRemoteTools(pi, remote);
  pi.on("session_shutdown", closeAll);
}
