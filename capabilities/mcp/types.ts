export interface McpToolSpec {
  readonly name: string;
}

export interface McpCapabilitySpec {
  readonly kind: "mcp";
  readonly id: string;
  readonly endpoint: string;
  readonly tools: readonly McpToolSpec[];
}

export type BuiltinCapabilitySpec = { readonly kind: "builtin"; readonly name: "read" | "edit" | "write" | "bash" };
export type CapabilitySpec = BuiltinCapabilitySpec | McpCapabilitySpec;
