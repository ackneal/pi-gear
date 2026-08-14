export interface McpToolSpec {
  readonly name: string;
}

export interface McpCapabilitySpec {
  readonly kind: "mcp";
  readonly id: string;
  readonly endpoint: string;
  readonly tools: readonly McpToolSpec[];
}

export type CapabilitySpec = { readonly kind: "builtin"; readonly name: "read" } | McpCapabilitySpec;
